import type { MetadataRoute } from "next";

/** Makes the web app installable ("Add to Home screen") on Android and desktop; iOS uses the apple-* tags in layout. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "PrintFlow",
    short_name: "PrintFlow",
    description: "Upload, pay and collect your campus printing without the queue.",
    start_url: "/dashboard?source=app",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Android builds the installed app's own splash from background_color plus the
    // 512 icon, so this is the brand ink — the same screen the mobile app shows.
    background_color: "#000906",
    theme_color: "#05402d",
    lang: "en-NG",
    categories: ["education", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Print something", short_name: "Print", url: "/student/print", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "My orders", short_name: "Orders", url: "/student/orders", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}