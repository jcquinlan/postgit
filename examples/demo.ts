import { Sequence, HitEndpoint, Sleep, SendEmail, ref } from "../src/sdk";

export function workflow() {
  return Sequence({
    id: "root",
    children: [
      HitEndpoint({
        id: "fetch-data",
        url: "https://httpbin.org/json",
        assignTo: "$.fetchResult",
      }),
      Sleep({
        id: "wait",
        seconds: 10,
      }),
      SendEmail({
        id: "notify",
        to: "user@example.com",
        subject: "Workflow Complete",
        body: ref("$.fetchResult.body.slideshow.title"),
      }),
    ],
  });
}
