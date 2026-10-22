/**
 * Metro bundles images as modules; TypeScript needs telling what they resolve to.
 */
declare module "*.png" {
    import type { ImageSourcePropType } from "react-native";
    const source: ImageSourcePropType;
    export default source;
}