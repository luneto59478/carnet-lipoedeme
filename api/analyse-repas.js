// Carnet Lipœdème — reconnaissance des aliments à partir d'une photo de repas.
// Fonction Vercel : reçoit la photo, la fait analyser par Claude, renvoie la liste proposée.
// Réglages à mettre dans Vercel (Settings → Environment Variables), JAMAIS dans GitHub :
//   ANTHROPIC_API_KEY = la clé API (console.anthropic.com)
//   CARNET_CODE       = le code d'accès personnel choisi par Catherine
//   CARNET_MODELE     = (facultatif) modèle à utiliser, par défaut claude-haiku-5-5

const UNITES = ["g", "ml", "portion", "c. à soupe", "pièce", "bol"];

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ erreur: "methode" });

  const cle = process.env.ANTHROPIC_API_KEY;
  const code = process.env.CARNET_CODE;
  if (!cle || !code) return res.status(500).json({ erreur: "config" });

  let corps = req.body;
  if (typeof corps === "string") { try { corps = JSON.parse(corps); } catch (e) { corps = null; } }
  if (!corps || typeof corps !== "object") return res.status(400).json({ erreur: "requete" });
  if (String(corps.code || "") !== code) return res.status(401).json({ erreur: "code" });

  const image = String(corps.image || "");
  const type = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(corps.type) ? corps.type : "image/jpeg";
  if (!image || image.length > 4000000) return res.status(400).json({ erreur: "image" });

  const cats = Array.isArray(corps.categories) ? corps.categories.slice(0, 30)
    .filter(c => c && typeof c.id === "string" && typeof c.n === "string")
    .map(c => ({ id: c.id.slice(0, 10), n: c.n.slice(0, 60) })) : [];
  if (!cats.length) return res.status(400).json({ erreur: "categories" });
  const repas = String(corps.repas || "repas").slice(0, 30);

  const outil = {
    name: "enregistrer_repas",
    description: "Enregistre la liste des aliments visibles sur la photo du repas.",
    input_schema: {
      type: "object",
      properties: {
        aliments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              aliment: { type: "string", description: "Nom simple en français, en minuscules (ex. « riz blanc », « poisson grillé », « salade verte »)" },
              qte: { type: "number", description: "Quantité estimée dans l'assiette" },
              unite: { type: "string", enum: UNITES },
              cat: { type: "string", enum: cats.map(c => c.id) },
              kcal: { type: "number", description: "Énergie estimée pour cette quantité (kcal)" },
              incertain: { type: "boolean", description: "true si l'aliment ou la quantité est difficile à identifier" }
            },
            required: ["aliment", "qte", "unite", "cat", "kcal"]
          }
        },
        remarque: { type: "string", description: "Une phrase courte, facultative (ex. sauce non visible, portion difficile à estimer)" }
      },
      required: ["aliments"]
    }
  };

  const consigne =
    `Tu es diététicien. Voici la photo d'un repas (${repas.toLowerCase()}) pris en Nouvelle-Calédonie. ` +
    `Liste chaque aliment visible séparément (pas le plat entier quand ses composants sont distincts), ` +
    `avec la quantité estimée pour UNE personne (grammes pour les solides, ml pour les boissons et soupes, ` +
    `« pièce » pour un fruit ou un œuf entier). Estime les kcal à partir des tables Ciqual. ` +
    `Choisis pour chaque aliment la catégorie la plus juste parmi : ` +
    cats.map(c => `${c.id} = ${c.n}`).join(" ; ") + ". " +
    `N'invente pas d'aliment invisible. Si la photo ne montre pas de nourriture, renvoie une liste vide avec une remarque.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cle, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.CARNET_MODELE || "claude-haiku-5-5",
        max_tokens: 1500,
        tools: [outil],
        tool_choice: { type: "tool", name: "enregistrer_repas" },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: type, data: image } },
            { type: "text", text: consigne }
          ]
        }]
      })
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const t = data && data.error && data.error.type;
      return res.status(502).json({ erreur: t === "rate_limit_error" || t === "overloaded_error" ? "occupe" : t === "authentication_error" ? "cle" : t === "invalid_request_error" && /credit/i.test(JSON.stringify(data)) ? "credit" : "ia" });
    }
    const bloc = (data.content || []).find(b => b.type === "tool_use");
    const sortie = (bloc && bloc.input) || {};
    const ids = new Set(cats.map(c => c.id));
    const aliments = (Array.isArray(sortie.aliments) ? sortie.aliments : []).slice(0, 25).map(a => ({
      aliment: String(a.aliment || "").trim().slice(0, 60),
      qte: Math.max(0, Math.round(Number(a.qte) || 0)),
      unite: UNITES.includes(a.unite) ? a.unite : "g",
      cat: ids.has(a.cat) ? a.cat : cats[0].id,
      kcal: Math.max(0, Math.round(Number(a.kcal) || 0)),
      incertain: !!a.incertain
    })).filter(a => a.aliment);
    return res.status(200).json({ aliments, remarque: String(sortie.remarque || "").slice(0, 300) });
  } catch (e) {
    return res.status(502).json({ erreur: "reseau" });
  }
};
