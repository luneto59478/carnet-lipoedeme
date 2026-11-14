// Carnet Lipœdème — reconnaissance des aliments à partir d'une photo de repas.
// Fonction Vercel : reçoit la photo, la fait analyser par Google Gemini (formule gratuite),
// renvoie la liste des aliments proposés.
// Réglages à mettre dans Vercel (Settings → Environment Variables), JAMAIS dans GitHub :
//   GEMINI_API_KEY = la clé créée sur aistudio.google.com
//   CARNET_CODE    = le code d'accès personnel choisi par Catherine
//   GEMINI_MODELE  = (facultatif) modèle à utiliser en priorité

const UNITES = ["g", "ml", "portion", "c. à soupe", "pièce", "bol", "carré"];
// Essayés dans l'ordre : si Google retire un modèle, le suivant prend le relais.
const MODELES = ["gemini-flash-latest", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-flash-lite-latest"];

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ erreur: "methode" });

  const cle = process.env.GEMINI_API_KEY;
  const code = process.env.CARNET_CODE;
  if (!cle || !code) return res.status(500).json({ erreur: "config" });

  let corps = req.body;
  if (typeof corps === "string") { try { corps = JSON.parse(corps); } catch (e) { corps = null; } }
  if (!corps || typeof corps !== "object") return res.status(400).json({ erreur: "requete" });
  if (String(corps.code || "") !== code) return res.status(401).json({ erreur: "code" });

  const image = String(corps.image || "");
  const type = ["image/jpeg", "image/png", "image/webp"].includes(corps.type) ? corps.type : "image/jpeg";
  if (!image || image.length > 4000000) return res.status(400).json({ erreur: "image" });

  const cats = Array.isArray(corps.categories) ? corps.categories.slice(0, 30)
    .filter(c => c && typeof c.id === "string" && typeof c.n === "string")
    .map(c => ({ id: c.id.slice(0, 10), n: c.n.slice(0, 60) })) : [];
  if (!cats.length) return res.status(400).json({ erreur: "categories" });
  const repas = String(corps.repas || "repas").slice(0, 30);

  const schema = {
    type: "OBJECT",
    properties: {
      aliments: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            aliment: { type: "STRING", description: "Nom simple en français, en minuscules" },
            qte: { type: "NUMBER", description: "Quantité estimée pour une personne" },
            unite: { type: "STRING", enum: UNITES },
            cat: { type: "STRING", enum: cats.map(c => c.id) },
            kcal: { type: "NUMBER", description: "Énergie estimée pour cette quantité" },
            incertain: { type: "BOOLEAN" }
          },
          required: ["aliment", "qte", "unite", "cat", "kcal"]
        }
      },
      remarque: { type: "STRING" }
    },
    required: ["aliments"]
  };

  const consigne =
    `Tu es diététicien. Voici la photo d'un repas (${repas.toLowerCase()}) pris en Nouvelle-Calédonie. ` +
    `Liste chaque aliment visible séparément (pas le plat entier quand ses composants sont distincts), ` +
    `avec la quantité estimée pour UNE personne (grammes pour les solides, ml pour les boissons et soupes, ` +
    `« pièce » pour un fruit ou un œuf entier, « carré » pour des carrés de chocolat). ` +
    `Estime les kcal à partir des tables Ciqual. Mets incertain = true si l'aliment ou la quantité est difficile à juger. ` +
    `Choisis pour chaque aliment la catégorie la plus juste parmi : ` +
    cats.map(c => `${c.id} = ${c.n}`).join(" ; ") + ". " +
    `N'invente pas d'aliment invisible. Si la photo ne montre pas de nourriture, renvoie une liste vide ` +
    `et explique-le dans « remarque » (une phrase courte, en français).`;

  const requete = JSON.stringify({
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: type, data: image } }, { text: consigne }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2, maxOutputTokens: 2048 }
  });

  const modeles = [process.env.GEMINI_MODELE, ...MODELES].filter((m, i, a) => m && a.indexOf(m) === i);
  let derniere = "ia";
  for (const modele of modeles) {
    let r, data;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modele)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": cle, "content-type": "application/json" },
        body: requete
      });
      data = await r.json().catch(() => null);
    } catch (e) { derniere = "reseau"; continue; }

    if (!r.ok) {
      const err = (data && data.error) || {};
      const msg = String(err.message || "");
      if (r.status === 404 || err.status === "NOT_FOUND") { derniere = "ia"; continue; }           // modèle retiré → suivant
      if (/api key/i.test(msg) || r.status === 403) return res.status(502).json({ erreur: "cle" });
      if (r.status === 429 || err.status === "RESOURCE_EXHAUSTED") return res.status(502).json({ erreur: "quota" });
      if (err.status === "FAILED_PRECONDITION") return res.status(502).json({ erreur: "region" });
      if (r.status >= 500) { derniere = "occupe"; continue; }
      derniere = "ia"; continue;
    }

    const cand = data && data.candidates && data.candidates[0];
    const texte = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || "").join("");
    let sortie = null;
    try { sortie = JSON.parse(texte); }
    catch (e) { const m = texte.match(/\{[\s\S]*\}/); if (m) { try { sortie = JSON.parse(m[0]); } catch (e2) { } } }
    if (!sortie) { derniere = "ia"; continue; }

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
  }
  return res.status(502).json({ erreur: derniere });
};
