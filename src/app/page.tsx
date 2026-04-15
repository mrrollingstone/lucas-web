import { redirect } from "next/navigation";

// `/` redirects to `/review` so the landing experience is discoverable
// and the root never serves a 404 during Vercel preview deploys.
export default function Home() {
  redirect("/review");
}
