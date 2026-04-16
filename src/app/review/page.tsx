import { redirect } from "next/navigation";

// Old /review URL → redirect to /buy so bookmarks don't 404.
export default function ReviewRedirect() {
  redirect("/buy");
}
