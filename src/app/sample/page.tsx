import { redirect } from "next/navigation";

/**
 * /sample
 *
 * The sample listing review lives as a static HTML file at /public/sample.html
 * so it can render as part of the existing site without needing Next.js to
 * build it. This route exists only as a redirect target in case anything
 * points at /sample without the .html extension.
 */
export default function SampleRoute() {
  redirect("/sample.html");
}
