import { sendEmail, failFor } from "../src/dsl";

export async function workflow() {
  // This will fail twice, then succeed on the 3rd attempt
  await failFor(2);
  
  await sendEmail({
    to: "user@example.com",
    subject: "Retry Demo Complete",
    body: "Successfully recovered from intentional failures!",
  });
}
