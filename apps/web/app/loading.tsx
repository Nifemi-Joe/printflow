import { BrandLoader } from "@/components/Splash";

/**
 * Next renders this while a route segment is still being fetched. It covers the
 * viewport, so a slow navigation shows the brand rather than a white page.
 */
export default function Loading() {
    return <BrandLoader full />;
}