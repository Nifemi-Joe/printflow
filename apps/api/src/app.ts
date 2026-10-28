import "reflect-metadata";
import { type INestApplication, Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import pg from "pg";
import type { Logger } from "pino";
import { createStorage, type ObjectStorage } from "../../../packages/storage/src/index.js";
import { checkoutMode, type AppConfig } from "./config.js";
import { Access } from "./http/access.js";
import { authMiddleware, baseMiddleware } from "./http/context.js";
import { ApiExceptionFilter } from "./http/errors.js";
import { RateLimiter } from "./http/rate-limit.js";
import { createLogger } from "./infra/logger.js";
import { BackgroundMailer, CaptureMailer, LogMailer, NoneMailer, SmtpMailer, type Mailer } from "./infra/mailer.js";
import { PaystackProvider, TestPaymentProvider, type PaymentProvider } from "./infra/payment-provider.js";
import { BackgroundSms, CaptureSms, LogSms, NoneSms, TermiiSms, type SmsSender } from "./infra/sms.js";
import { CONFIG, LOGGER, MAILER, PAYMENT_PROVIDER, PG_POOL, SMS, STORAGE } from "./infra/tokens.js";
import { AuthController, AuthService, MeController } from "./modules/auth.js";
import { PhoneController } from "./modules/phone.js";
import { CatalogueController } from "./modules/catalogue.js";
import { DocumentsController } from "./modules/documents.js";
import { FilesController, HealthController, PaymentsController, TestPaymentsController, WebhookProcessor, WebhooksController } from "./modules/payments.js";
import { EnquiriesController, PlatformEnquiriesController } from "./modules/enquiries.js";
import { PlatformController } from "./modules/platform.js";
import { ShopController } from "./modules/shop.js";
import { StudentOrdersController } from "./modules/student-orders.js";
import { UniversityAdminController } from "./modules/university.js";
import { UniversityWalletController, WalletController } from "./modules/wallet.js";
import { ProviderVerificationController, UniversityProvidersController } from "./modules/provider.js";

export interface AppDeps {
  pool: pg.Pool;
  log: Logger;
  storage: ObjectStorage;
  mailer: Mailer;
  sms: SmsSender;
  payments: PaymentProvider | null;
}

export function createSms(cfg: AppConfig, log: Logger): SmsSender {
  switch (cfg.SMS_DRIVER) {
    case "TERMII":
      return new BackgroundSms(
          new TermiiSms({ apiKey: cfg.TERMII_API_KEY!, senderId: cfg.TERMII_SENDER_ID!, baseUrl: cfg.TERMII_BASE_URL, channel: cfg.TERMII_CHANNEL }),
          log,
      );
    case "CAPTURE":
      return new CaptureSms();
    case "LOG":
      return new LogSms(log, cfg.devConsole);
    default:
      return new NoneSms();
  }
}

export function createDeps(cfg: AppConfig, overrides: Partial<AppDeps> = {}): AppDeps {
  const log = overrides.log ?? createLogger(cfg.LOG_LEVEL);
  const mode = checkoutMode(cfg);
  return {
    log,
    pool: overrides.pool ?? new pg.Pool({ connectionString: cfg.DATABASE_URL, max: cfg.DATABASE_POOL_MAX, statement_timeout: 30_000 }),
    storage: overrides.storage ?? createStorage(cfg),
    mailer:
        overrides.mailer ??
        (cfg.EMAIL_DRIVER === "SMTP"
            ? new BackgroundMailer(new SmtpMailer({ url: cfg.SMTP_URL!, from: cfg.EMAIL_FROM, requireTls: cfg.SMTP_REQUIRE_TLS }), log)
            : cfg.EMAIL_DRIVER === "CAPTURE"
                ? new CaptureMailer()
                : cfg.EMAIL_DRIVER === "LOG"
                    ? new LogMailer(log, cfg.devConsole)
                    : new NoneMailer()),
    sms: overrides.sms ?? createSms(cfg, log),
    payments:
        overrides.payments !== undefined
            ? overrides.payments
            : mode === "LIVE"
                ? new PaystackProvider(cfg.PAYSTACK_SECRET_KEY!)
                : mode === "TEST"
                    ? new TestPaymentProvider(cfg.PUBLIC_WEB_URL, cfg.TEST_WEBHOOK_SECRET)
                    : null,
  };
}

export const CONTROLLERS = [
  HealthController,
  AuthController,
  MeController,
  PhoneController,
  CatalogueController,
  DocumentsController,
  StudentOrdersController,
  WebhooksController,
  TestPaymentsController,
  PaymentsController,
  FilesController,
  ShopController,
  UniversityAdminController,
  PlatformController,
  EnquiriesController,
  PlatformEnquiriesController,
  WalletController,
  UniversityWalletController,
  ProviderVerificationController,
  UniversityProvidersController,
];

@Module({})
class AppModule {
  static register(cfg: AppConfig, deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: CONTROLLERS,
      providers: [
        { provide: CONFIG, useValue: cfg },
        { provide: PG_POOL, useValue: deps.pool },
        { provide: LOGGER, useValue: deps.log },
        { provide: STORAGE, useValue: deps.storage },
        { provide: MAILER, useValue: deps.mailer },
        { provide: SMS, useValue: deps.sms },
        { provide: PAYMENT_PROVIDER, useValue: deps.payments },
        { provide: Access, useFactory: () => new Access(deps.pool, cfg) },
        { provide: RateLimiter, useFactory: () => new RateLimiter(deps.pool, cfg.RATE_LIMIT_SCALE) },
        { provide: AuthService, useFactory: () => new AuthService(deps.pool, cfg, deps.mailer) },
        { provide: WebhookProcessor, useFactory: () => new WebhookProcessor(deps.pool, cfg, deps.log) },
      ],
    };
  }
}

export async function createApp(cfg: AppConfig, deps: AppDeps): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(cfg, deps), {
    rawBody: true,
    logger: cfg.NODE_ENV === "test" ? false : ["error", "warn"],
    bodyParser: true,
  });
  app.disable("x-powered-by");
  if (cfg.TRUST_PROXY) app.set("trust proxy", 1);
  app.useBodyParser("json", { limit: "256kb" });
  app.use(baseMiddleware(cfg));
  app.use(authMiddleware(cfg, deps.pool, deps.log));
  app.useGlobalFilters(new ApiExceptionFilter(deps.log));
  app.enableShutdownHooks();
  return app;
}