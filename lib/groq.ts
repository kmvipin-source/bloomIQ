import Groq from "groq-sdk";

const groqClient = new Groq({
  apiKey: process.env.NEXT_PUBLIC_GROQ_API_KEY!,
});

export const GROQ_MODEL = "llama-3.3-70b-versatile";
// Vision-capable model on Groq for multimodal (image) prompts
export const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

function parseJsonLoose(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract the first {...} block (vision models sometimes wrap JSON in prose)
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

export async function groqJSON(systemPrompt: string, userPrompt: string) {
  const res = await groqClient.chat.completions.create({
    model: GROQ_MODEL,
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const text = res.choices[0]?.message?.content || "{}";
  return parseJsonLoose(text);
}

export async function groqJSONVision(
  systemPrompt: string,
  userPrompt: string,
  imageDataUrl: string
) {
  const res = await groqClient.chat.completions.create({
    model: GROQ_VISION_MODEL,
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });
  const text = res.choices[0]?.message?.content || "{}";
  return parseJsonLoose(text);
}

export async function groqText(systemPrompt: string, userPrompt: string) {
  const res = await groqClient.chat.completions.create({
    model: GROQ_MODEL,
    temperature: 0.6,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  return res.choices[0]?.message?.content?.trim() || "";
}

export default groqClient;
