// ONE place that answers "what language is the user writing?".
//
// WHY THIS FILE EXISTS: the language heuristics were duplicated and WRONG in
// three agent.js reply builders. `buildGreetingReply` matched English "hi"/"hey"
// as Hinglish (its regex literally listed `hi|hey`), so a user saying "hi" in
// English was answered in Hinglish. The rule the product wants is the opposite:
// START IN ENGLISH when the language is unknown (the user may speak English),
// then MIRROR the user's language once they show it. One detector, English by
// default, no false positives on plain English greetings.

const HINGLISH_MARKERS = new RegExp(
  "\\b(?:" +
  "kya|kaise|kaisa|kaisay|hai|hain|hoon|hun|ho|nahi|nahin|nhi|" +
  "mujhe|muje|tumhe|tum|tumhara|tumhari|tera|teri|mera|meri|hamara|apna|" +
  "karo|karna|kar|kro|banao|bana|banaao|bata|batao|bolo|bol|" +
  "theek|thik|accha|achha|acha|haan|han|nai|aur|lekin|phir|abhi|" +
  "salam|namaste|namaskar|dhanyavad|shukriya|yaar|bhai|behen|" +
  "kaam|naam|matlab|kaun|kahan|kab|kyun|kyu|kaise|chahiye|chaiye|" +
  "koi|kuch|bahut|bohot|accha|zaroor|zara|jaldi|" +
  "ma|mai|hu|hun|hoon" +
  ")\\b",
  "gi",
);

/**
 * Detect the user's language from a single message.
 * Returns "devanagari" | "arabic" | "hinglish" | "english".
 * English is the DEFAULT: unknown/ambiguous input is treated as English so the
 * agent never opens in a language the user did not use.
 */
export function detectUserLanguage(message = "") {
  const raw = String(message || "");
  if (/[\u0900-\u097F]/.test(raw)) return "devanagari"; // Hindi (Devanagari)
  if (/[\u0600-\u06FF]/.test(raw)) return "arabic";      // Urdu/Arabic script
  const lower = raw.toLowerCase();
  const hits = new Set(lower.match(HINGLISH_MARKERS) || []);
  // One marker is too weak ("main()" in code, a stray "hai"); require two
  // distinct Romanised-Hindi cues before we assume Hinglish.
  return hits.size >= 2 ? "hinglish" : "english";
}

/** True only when the message is clearly NOT English. */
export function isNonEnglish(message = "") {
  return detectUserLanguage(message) !== "english";
}
