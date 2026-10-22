import { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";

export function createS3Client(config: AppConfig): S3Client {
    return new S3Client({
        region: config.AWS_REGION || "ap-southeast-2",
        credentials: {
            accessKeyId: config.AWS_ACCESS_KEY_ID,
            secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
        },
        forcePathStyle: false, // Use virtual-hosted-style URLs
    });
}