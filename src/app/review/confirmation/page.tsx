import { redirect } from "next/navigation";

export default function ReviewConfirmationRedirect() {
  redirect("/buy/confirmation");
}
