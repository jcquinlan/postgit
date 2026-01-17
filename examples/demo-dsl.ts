import { hitEndpoint, sleep, sendEmail } from "../src/dsl";

export async function workflow() {
  const response = await hitEndpoint("https://httpbin.org/json");
  
  await sleep(10);
  
  await sendEmail({
    to: "user@example.com",
    subject: "Workflow Complete",
    body: response.body.slideshow.title,
  });
}
