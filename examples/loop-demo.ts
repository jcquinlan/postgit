import { hitEndpoint, sleep, sendEmail } from "../src/dsl";

export async function workflow() {
  const response = await hitEndpoint("https://httpbin.org/json");

  // Loop over the slides and send an email for each
  for (const slide of response.body.slideshow.slides) {
    await sendEmail({
      to: "user@example.com",
      subject: slide.title,
      body: slide.type,
    });
    
    await sleep(2);
  }
}
