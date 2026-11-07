require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PIXMO_BASE = "https://pixmo.ai/api/v1";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const SIGNUP_CREDITS = Math.max(0, Number.parseInt(process.env.SIGNUP_CREDITS || "25", 10));
const SQLiteStore = SQLiteStoreFactory(session);

if (!process.env.PIXMO_API_KEY) console.warn("WARNING: PIXMO_API_KEY is not set.");
if (process.env.NODE_ENV === "production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error("SESSION_SECRET must be at least 32 characters in production.");
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "platform.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  credits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pixmo_task_id TEXT UNIQUE,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  duration TEXT NOT NULL,
  resolution TEXT NOT NULL,
  credits_charged INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'SUBMITTING',
  video_url TEXT,
  error_message TEXT,
  refunded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON credit_ledger(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  package_id TEXT NOT NULL,
  amount_kes INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  phone TEXT NOT NULL,
  merchant_request_id TEXT,
  checkout_request_id TEXT UNIQUE,
  receipt_number TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  result_description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments(user_id, created_at DESC);
`);

const statements = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userById: db.prepare("SELECT id,email,role,credits,created_at FROM users WHERE id = ?"),
  insertUser: db.prepare("INSERT INTO users (email,password_hash,role,credits) VALUES (?,?,?,?)"),
  jobsForUser: db.prepare("SELECT id,prompt,model,duration,resolution,credits_charged,status,video_url,error_message,created_at FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 50"),
  jobForUser: db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=?"),
  insertJob: db.prepare("INSERT INTO jobs (user_id,prompt,model,duration,resolution,credits_charged,status) VALUES (?,?,?,?,?,?,?)"),
  ledger: db.prepare("INSERT INTO credit_ledger (user_id,amount,reason,job_id) VALUES (?,?,?,?)"),
  updateJob: db.prepare("UPDATE jobs SET pixmo_task_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"),
  updateJobResult: db.prepare("UPDATE jobs SET status=?,video_url=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"),
  refundJob: db.prepare("UPDATE jobs SET refunded=1,status='FAILED',error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND refunded=0"),
  addCredits: db.prepare("UPDATE users SET credits=credits+? WHERE id=?"),
  spendCredits: db.prepare("UPDATE users SET credits=credits-? WHERE id=? AND credits>=?"),
  allUsers: db.prepare("SELECT id,email,role,credits,created_at FROM users ORDER BY id DESC LIMIT 250"),
  allJobs: db.prepare("SELECT j.id,j.user_id,u.email,j.prompt,j.status,j.credits_charged,j.created_at FROM jobs j JOIN users u ON u.id=j.user_id ORDER BY j.id DESC LIMIT 100"),
  insertPayment: db.prepare("INSERT INTO payments (user_id,package_id,amount_kes,credits,phone,merchant_request_id,checkout_request_id,status) VALUES (?,?,?,?,?,?,?,'PENDING')"),
  paymentByCheckout: db.prepare("SELECT * FROM payments WHERE checkout_request_id=?"),
  paymentForUser: db.prepare("SELECT * FROM payments WHERE id=? AND user_id=?"),
  paymentUpdate: db.prepare("UPDATE payments SET status=?,receipt_number=COALESCE(?,receipt_number),result_description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"),
  paymentsForUser: db.prepare("SELECT id,package_id,amount_kes,credits,phone,receipt_number,status,created_at FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 30")
};

const txCreateJob = db.transaction(({ userId, prompt, model, duration, resolution, cost }) => {
  const changed = statements.spendCredits.run(cost, userId, cost).changes;
  if (!changed) throw new Error("NOT_ENOUGH_CREDITS");
  const job = statements.insertJob.run(userId, prompt, model, duration, resolution, cost);
  statements.ledger.run(userId, -cost, "Video generation", job.lastInsertRowid);
  return Number(job.lastInsertRowid);
});

const txRefund = db.transaction((job) => {
  const changed = statements.refundJob.run(job.error_message || "Generation failed", job.id).changes;
  if (changed) {
    statements.addCredits.run(job.credits_charged, job.user_id);
    statements.ledger.run(job.user_id, job.credits_charged, "Refund: generation failed", job.id);
  }
});

function safeUser(user) {
  return user ? { id: user.id, email: user.email, role: user.role, credits: user.credits } : null;
}
function currentUser(req) {
  return req.session.userId ? statements.userById.get(req.session.userId) : null;
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please sign in to continue." });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
  next();
}
function pixmoHeaders() {
  if (!process.env.PIXMO_API_KEY) {
    const e = new Error("The website administrator has not configured the Pixmo API key.");
    e.status = 503;
    throw e;
  }
  return { Authorization: `Bearer ${process.env.PIXMO_API_KEY}`, "Content-Type": "application/json" };
}
async function pixmoRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...pixmoHeaders(), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(data.message || data.error?.message || `Pixmo API error (${response.status})`);
    e.status = response.status >= 500 ? 502 : response.status;
    throw e;
  }
  return data;
}
function estimatedCost(model, duration) {
  const seconds = Number.parseInt(duration, 10);
  // Pixmo published 720p rates: sd2-fast = 5 credits/sec, sd2 = 6 credits/sec.
  return seconds * (model === "sd2-fast" ? 5 : 6);
}
function outputUrl(data) {
  return data.output?.[0]?.url || data.result?.url || data.output?.[0]?.videoUrl || null;
}
function refreshJobFromPixmo(localJob, data) {
  const status = String(data.status || "PROCESSING").toUpperCase();
  if (["FAILED", "ERROR"].includes(status)) {
    const message = typeof data.error === "string" ? data.error : data.error?.message || "Pixmo could not generate this video.";
    const fresh = statements.jobForUser.get(localJob.id, localJob.user_id);
    txRefund({ ...fresh, error_message: message });
    return;
  }
  if (["COMPLETED", "SUCCESS", "SUCCEEDED"].includes(status)) {
    statements.updateJobResult.run("COMPLETED", outputUrl(data), null, localJob.id);
  } else {
    statements.updateJobResult.run(status, null, null, localJob.id);
  }
}


const CREDIT_PACKAGES = [
  { id: "mini", name: "Mini", amountKes: 100, credits: 100 },
  { id: "creator", name: "Creator", amountKes: 300, credits: 330 },
  { id: "studio", name: "Studio", amountKes: 700, credits: 800 },
  { id: "agency", name: "Agency", amountKes: 1500, credits: 1800 }
];
function mpesaConfigured() {
  return Boolean(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET &&
    process.env.MPESA_SHORTCODE && process.env.MPESA_PASSKEY &&
    process.env.APP_URL && /^https:\/\//i.test(process.env.APP_URL));
}
function mpesaBase() {
  return process.env.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
}
function mpesaTimestamp() {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi", year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23"
  }).formatToParts(new Date()).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}
function mpesaPassword(ts) {
  return Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${ts}`).toString("base64");
}
async function mpesaToken() {
  const basic = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString("base64");
  const r = await fetch(`${mpesaBase()}/oauth/v1/generate?grant_type=client_credentials`, {headers:{Authorization:`Basic ${basic}`}});
  const d = await r.json().catch(()=>({}));
  if (!r.ok || !d.access_token) throw new Error(d.errorMessage || "M-Pesa authentication failed.");
  return d.access_token;
}
async function queryMpesa(checkoutId) {
  const token = await mpesaToken(), ts = mpesaTimestamp();
  const r = await fetch(`${mpesaBase()}/mpesa/stkpushquery/v1/query`, {
    method:"POST", headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:JSON.stringify({BusinessShortCode:process.env.MPESA_SHORTCODE,Password:mpesaPassword(ts),Timestamp:ts,CheckoutRequestID:checkoutId})
  });
  const d = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(d.errorMessage || "Could not verify M-Pesa payment.");
  return d;
}
function creditPaidPayment(payment, receipt) {
  return db.transaction(() => {
    const current = db.prepare("SELECT * FROM payments WHERE id=?").get(payment.id);
    if (!current || current.status === "PAID") return;
    statements.addCredits.run(current.credits,current.user_id);
    statements.ledger.run(current.user_id,current.credits,`M-Pesa top-up (${receipt})`,null);
    statements.paymentUpdate.run("PAID",receipt,"Verified payment",current.id);
  })();
}

// First administrator is provisioned from environment variables, never from public signup.
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const existing = statements.userByEmail.get(email);
  if (!existing) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
    statements.insertUser.run(email, hash, "admin", 0);
    console.log(`Administrator account created for ${email}`);
  } else if (existing.role !== "admin") {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(existing.id);
  }
}

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      mediaSrc: ["'self'", "https:", "blob:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null
    }
  }
}));
app.use(express.json({ limit: "100kb" }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: DATA_DIR, concurrentDB: true }),
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  name: "pixmo.sid",
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use(express.static(path.join(__dirname, "public")));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: "draft-7", legacyHeaders: false });
const generateLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/me", (req, res) => {
  const user = currentUser(req);
  res.json({ user: safeUser(user), signupsAllowed: process.env.ALLOW_SIGNUPS !== "false" });
});

app.post("/api/register", authLimiter, async (req, res) => {
  if (process.env.ALLOW_SIGNUPS === "false") return res.status(403).json({ error: "New registrations are currently closed." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 10 || password.length > 128) return res.status(400).json({ error: "Password must be 10–128 characters long." });
  if (statements.userByEmail.get(email)) return res.status(409).json({ error: "An account with that email already exists." });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = statements.insertUser.run(email, hash, "user", SIGNUP_CREDITS);
    statements.ledger.run(Number(result.lastInsertRowid), SIGNUP_CREDITS, "Welcome signup credits", null);
    req.session.userId = Number(result.lastInsertRowid);
    res.status(201).json({ user: safeUser(statements.userById.get(req.session.userId)) });
  } catch (error) {
    res.status(500).json({ error: "Could not create your account." });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = statements.userByEmail.get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "Incorrect email or password." });
  req.session.userId = user.id;
  res.json({ user: safeUser(statements.userById.get(user.id)) });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/jobs", requireAuth, (req, res) => {
  res.json({ jobs: statements.jobsForUser.all(req.user.id) });
});

app.post("/api/videos", requireAuth, generateLimiter, async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  const model = req.body?.model === "sd2-fast" ? "sd2-fast" : "sd2";
  const duration = String(req.body?.duration || "5s");
  const resolution = String(req.body?.resolution || "1280x720");
  const generateAudio = req.body?.generateAudio !== false;

  if (prompt.length < 3 || prompt.length > 5000) return res.status(400).json({ error: "Prompt must be between 3 and 5,000 characters." });
  if (!/^([4-9]|1[0-5])s$/.test(duration)) return res.status(400).json({ error: "Choose a duration from 4 to 15 seconds." });
  if (!["720x720","720x960","960x720","1280x720","720x1280","1280x540"].includes(resolution)) return res.status(400).json({ error: "Unsupported video format." });

  const cost = estimatedCost(model, duration);
  let localJobId;
  try {
    localJobId = txCreateJob({ userId: req.user.id, prompt, model, duration, resolution, cost });
  } catch (error) {
    if (error.message === "NOT_ENOUGH_CREDITS") return res.status(402).json({ error: "You do not have enough credits. Contact the site administrator to top up your balance." });
    return res.status(500).json({ error: "Could not reserve credits for this video." });
  }

  try {
    const data = await pixmoRequest(`${PIXMO_BASE}/jobs/createTask`, {
      method: "POST",
      body: JSON.stringify({ model, inputs: { prompt, duration, resolution, generateAudio } })
    });
    if (!data.taskId) throw new Error("Pixmo did not return a task ID.");
    statements.updateJob.run(data.taskId, data.status || "PENDING", localJobId);
    res.status(202).json({
      job: { id: localJobId, taskId: data.taskId, status: data.status || "PENDING", creditsCharged: cost },
      user: safeUser(statements.userById.get(req.user.id))
    });
  } catch (error) {
    const job = statements.jobForUser.get(localJobId, req.user.id);
    txRefund({ ...job, error_message: error.message });
    res.status(error.status || 502).json({ error: error.message, refunded: true });
  }
});

app.get("/api/videos/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: "Invalid job ID." });
  const job = statements.jobForUser.get(id, req.user.id);
  if (!job) return res.status(404).json({ error: "Video job not found." });

  if (job.pixmo_task_id && !["COMPLETED", "FAILED"].includes(job.status)) {
    try {
      const data = await pixmoRequest(`${PIXMO_BASE}/jobs/queryTask?taskId=${encodeURIComponent(job.pixmo_task_id)}`);
      refreshJobFromPixmo(job, data);
    } catch (error) {
      return res.status(502).json({ error: error.message });
    }
  }
  const updated = statements.jobForUser.get(id, req.user.id);
  res.json({ job: {
    id: updated.id, prompt: updated.prompt, model: updated.model, duration: updated.duration,
    resolution: updated.resolution, creditsCharged: updated.credits_charged,
    status: updated.status, videoUrl: updated.video_url, error: updated.error_message,
    createdAt: updated.created_at
  }, user: safeUser(statements.userById.get(req.user.id)) });
});

app.get("/api/ledger", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT amount,reason,created_at FROM credit_ledger WHERE user_id=? ORDER BY id DESC LIMIT 50").all(req.user.id);
  res.json({ entries: rows });
});


app.get("/api/payments/config", (_req,res)=>res.json({mpesaEnabled:mpesaConfigured(),packages:CREDIT_PACKAGES}));
app.get("/api/payments", requireAuth, (req,res)=>res.json({payments:statements.paymentsForUser.all(req.user.id)}));

app.post("/api/payments/mpesa/initiate", requireAuth, generateLimiter, async (req,res)=>{
  if(!mpesaConfigured()) return res.status(503).json({error:"M-Pesa payments are not configured. Contact the administrator."});
  const pkg=CREDIT_PACKAGES.find(p=>p.id===String(req.body?.packageId||""));
  if(!pkg) return res.status(400).json({error:"Choose a valid credit package."});
  const raw=String(req.body?.phone||"").replace(/[\s()+-]/g,"");
  const phone=raw.startsWith("0")?`254${raw.slice(1)}`:(raw.startsWith("7")||raw.startsWith("1"))?`254${raw}`:raw;
  if(!/^254[17]\d{8}$/.test(phone)) return res.status(400).json({error:"Enter a valid Kenyan M-Pesa number, e.g. 0712345678."});
  try {
    const token=await mpesaToken(), ts=mpesaTimestamp();
    const payload={
      BusinessShortCode:process.env.MPESA_SHORTCODE,Password:mpesaPassword(ts),Timestamp:ts,
      TransactionType:process.env.MPESA_TRANSACTION_TYPE||"CustomerPayBillOnline",
      Amount:pkg.amountKes,PartyA:phone,PartyB:process.env.MPESA_SHORTCODE,PhoneNumber:phone,
      CallBackURL:`${process.env.APP_URL.replace(/\/$/,"")}/api/payments/mpesa/callback`,
      AccountReference:"MotionForge",TransactionDesc:`${pkg.credits} video credits`
    };
    const r=await fetch(`${mpesaBase()}/mpesa/stkpush/v1/processrequest`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||String(d.ResponseCode)!=="0"||!d.CheckoutRequestID) return res.status(502).json({error:d.errorMessage||d.ResponseDescription||"M-Pesa could not start the payment."});
    const saved=statements.insertPayment.run(req.user.id,pkg.id,pkg.amountKes,pkg.credits,phone,d.MerchantRequestID||null,d.CheckoutRequestID);
    res.status(202).json({paymentId:Number(saved.lastInsertRowid),message:"STK prompt sent. Enter your M-Pesa PIN on your phone."});
  } catch(e){res.status(502).json({error:e.message});}
});

app.post("/api/payments/mpesa/callback", async (req,res)=>{
  res.status(200).json({ResultCode:0,ResultDesc:"Accepted"});
  try {
    const cb=req.body?.Body?.stkCallback;
    if(!cb?.CheckoutRequestID) return;
    const payment=statements.paymentByCheckout.get(cb.CheckoutRequestID);
    if(!payment||payment.status==="PAID") return;
    if(Number(cb.ResultCode)!==0){
      statements.paymentUpdate.run("FAILED",null,cb.ResultDesc||"Payment was not completed.",payment.id);
      return;
    }
    const items=cb.CallbackMetadata?.Item||[];
    const meta=Object.fromEntries(items.map(x=>[x.Name,x.Value]));
    const receipt=String(meta.MpesaReceiptNumber||"");
    if(Number(meta.Amount)!==payment.amount_kes||!receipt){
      statements.paymentUpdate.run("REVIEW",receipt||null,"Payment amount/receipt mismatch. Manual review required.",payment.id);
      return;
    }
    const verified=await queryMpesa(payment.checkout_request_id);
    if(String(verified.ResultCode??verified.resultCode)==="0") creditPaidPayment(payment,receipt);
    else statements.paymentUpdate.run("REVIEW",receipt,"Daraja query did not confirm success. Manual review required.",payment.id);
  } catch(e){console.error("M-Pesa callback verification:",e.message);}
});

app.get("/api/payments/:id",requireAuth,(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)) return res.status(400).json({error:"Invalid payment ID."});
  const payment=db.prepare("SELECT id,package_id,amount_kes,credits,status,receipt_number,result_description,created_at FROM payments WHERE id=? AND user_id=?").get(id,req.user.id);
  if(!payment) return res.status(404).json({error:"Payment not found."});
  res.json({payment,user:safeUser(statements.userById.get(req.user.id))});
});

// Admin tools: user list, activity, and manual credit adjustments.
app.get("/api/admin/overview", requireAuth, requireAdmin, (_req, res) => {
  res.json({
    users: statements.allUsers.all(),
    jobs: statements.allJobs.all(),
    totals: {
      users: db.prepare("SELECT COUNT(*) n FROM users").get().n,
      jobs: db.prepare("SELECT COUNT(*) n FROM jobs").get().n,
      creditsOutstanding: db.prepare("SELECT COALESCE(SUM(credits),0) n FROM users").get().n,
      successfulPaymentsKes: db.prepare("SELECT COALESCE(SUM(amount_kes),0) n FROM payments WHERE status='PAID'").get().n,
      pendingPayments: db.prepare("SELECT COUNT(*) n FROM payments WHERE status IN ('PENDING','REVIEW')").get().n
    },
    payments: db.prepare("SELECT p.id,p.user_id,u.email,p.amount_kes,p.credits,p.status,p.receipt_number,p.created_at FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 100").all()
  });
});
app.post("/api/admin/credits", requireAuth, requireAdmin, (req, res) => {
  const userId = Number(req.body?.userId);
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason || "Administrator credit adjustment").trim().slice(0, 160);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(amount) || amount < 1 || amount > 100000) return res.status(400).json({ error: "Enter a valid user and credit amount (1–100,000)." });
  const target = statements.userById.get(userId);
  if (!target) return res.status(404).json({ error: "User not found." });
  const add = db.transaction(() => {
    statements.addCredits.run(amount, userId);
    statements.ledger.run(userId, amount, reason, null);
  });
  add();
  res.json({ user: statements.userById.get(userId) });
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Pixmo public video platform listening on port ${PORT}`));