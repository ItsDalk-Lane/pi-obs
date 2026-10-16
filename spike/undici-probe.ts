import { fetch as undiciFetch, Agent } from "undici";
async function main() {
  const t0 = Date.now();
  try {
    const r = await undiciFetch("http://127.0.0.1:1234/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer 00000" },
      body: JSON.stringify({ model: "qwen/qwen3.8-27b", messages: [{ role: "user", content: "只回复两个字：成功" }], max_tokens: 16, stream: false }),
    });
    const j: any = await r.json();
    console.log("undici status", r.status, "reply:", JSON.stringify(j.choices?.[0]?.message?.content ?? j).slice(0, 120), "ms:", Date.now() - t0);
  } catch (e: any) { console.log("undici FAIL:", e.message, "| cause:", e.cause?.message ?? "-"); }
}
main();
