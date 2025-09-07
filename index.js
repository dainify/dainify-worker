import express from "express";

const app = express();

// paprastas testinis puslapis
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Railway duos PORT automatiškai
const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log("Dainify worker listening on :" + port);
});
