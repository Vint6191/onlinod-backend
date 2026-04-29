require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("node:path");

const authRoutes = require("./routes/auth");
const creatorRoutes = require("./routes/creators");

const app = express();

app.set("trust proxy", 1);

app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    service: "onlinod-backend",
    version: "0.3.0",
    time: new Date().toISOString(),
  });
});

app.get("/api", (_req, res) => {
  res.json({
    ok: true,
    service: "onlinod-backend",
    version: "0.3.0",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/creators", creatorRoutes);

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/")) return next();
  return res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    code: "NOT_FOUND",
    error: `Route not found: ${req.method} ${req.path}`,
  });
});

app.use((err, _req, res, _next) => {
  console.error("[server] unhandled error:", err);

  res.status(500).json({
    ok: false,
    code: "SERVER_ERROR",
    error: "Internal server error",
  });
});

const port = Number(process.env.PORT || 10000);

app.listen(port, () => {
  console.log(`Onlinod backend running on port ${port}`);
});
