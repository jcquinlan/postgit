import { hitEndpoint, sleep, sendEmail, kv } from "../src/dsl";

export async function workflow() {
  const store = kv("demo-store");
  
  // Store a value
  await store.set("status", "running");
  
  // Fetch some data
  const response = await hitEndpoint("https://httpbin.org/json");
  
  // Store the fetched title in KV
  await store.set("lastTitle", response.body.slideshow.title);
  
  // Read it back
  const savedTitle = await store.get("lastTitle");
  
  // Update status
  await store.set("status", "completed");
  
  // Send email with the saved value
  await sendEmail({
    to: "user@example.com",
    subject: "KV Demo Complete",
    body: savedTitle,
  });
}
