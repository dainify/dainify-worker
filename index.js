import express from "express";
import crypto from "crypto";
import axios from "axios";

const app = express();

/** ---------- WEBHOOK: orders/paid (kol kas tik HMAC + ok) ---------- */
app.post("/webhooks/orders-paid", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
    const digest = crypto
      .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(req.body, "utf8")
      .digest("base64");

    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader))) {
      return res.status(401).send("unauthorized");
    }

    // čia vėliau darysim pilną atrakinimo logiką
    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(500).send("error");
  }
});

/** JSON middleware – po RAW webhooko */
app.use(express.json());

/** ---------- HEALTH ---------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/** ---------- Pagalbinės Shopify funkcijos ---------- */
const BASE = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_API_VERSION}`;

async function shopifyGraphQL(query, variables = {}) {
  const r = await axios.post(
    `${BASE}/graphql.json`,
    { query, variables },
    {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );
  if (r.data.errors) throw new Error(JSON.stringify(r.data.errors));
  return r.data.data;
}

async function getCustomerSongs(customerGID) {
  const q = `
    query GetSongs($id: ID!) {
      customer(id: $id) {
        id
        metafield(namespace: "dainify", key: "songs") { value }
      }
    }`;
  const data = await shopifyGraphQL(q, { id: customerGID });
  const raw = data?.customer?.metafield?.value || "[]";
  try { return JSON.parse(raw); } catch { return []; }
}

async function setCustomerSongs(customerGID, songsArray) {
  const m = `
    mutation SetSongs($ownerId: ID!, $val: String!) {
      metafieldsSet(metafields: [{
        ownerId: $ownerId,
        namespace: "dainify",
        key: "songs",
        type: "json",
        value: $val
      }]) {
        userErrors { field message }
      }
    }`;
  const val = JSON.stringify(songsArray);
  const data = await shopifyGraphQL(m, { ownerId: customerGID, val });
  const errs = data?.metafieldsSet?.userErrors;
  if (errs && errs.length) throw new Error("metafieldsSet: " + JSON.stringify(errs));
}

/** ---------- /api/preview (FAKE versija) ----------
 * Tikslas: įrašyti dainos „preview“ į kliento metafield,
 * naudojant PREVIEW_PLACEHOLDER_URL kaip demo audio.
 */
app.post("/api/preview", async (req, res) => {
  try {
    const { customer_id, title } = req.body || {};
    if (!customer_id) return res.status(400).json({ error: "Trūksta customer_id" });

    const previewUrl = process.env.PREVIEW_PLACEHOLDER_URL;
    if (!previewUrl) return res.status(500).json({ error: "Nėra PREVIEW_PLACEHOLDER_URL env" });

    const customerGID = `gid://shopify/Customer/${customer_id}`;
    const songs = await getCustomerSongs(customerGID);

    const songId = `SO_${Date.now()}`;
    songs.push({
      id: songId,
      status: "preview",
      title: title || `Daina (${new Date().toISOString().slice(0,10)})`,
      preview_url: previewUrl,
      created_at: new Date().toISOString()
    });

    await setCustomerSongs(customerGID, songs);
    return res.json({ ok: true, song_id: songId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Nepavyko įrašyti preview" });
  }
});

/** ---------- start ---------- */
const port = process.env.PORT || 8787;
app.listen(port, () => console.log("Dainify worker listening on :" + port));
