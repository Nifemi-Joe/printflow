import { describe, expect, it } from "vitest";
import {
  allowedNextStatuses,
  assertTransition,
  cancellationEligibility,
  ORDER_STATUS_LABELS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  TERMINAL_STATUSES,
  TransitionError,
} from "../src/index.js";

describe("order state machine", () => {
  it("has no transitions out of terminal states", () => {
    for (const s of TERMINAL_STATUSES) {
      expect(ORDER_TRANSITIONS.filter((t) => t.from === s)).toEqual([]);
    }
  });

  it("has no duplicate transitions", () => {
    const keys = ORDER_TRANSITIONS.map((t) => `${t.from}>${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("labels every status", () => {
    for (const s of ORDER_STATUSES) expect(ORDER_STATUS_LABELS[s]).toBeTruthy();
  });

  it("every non-terminal state can eventually reach a terminal state", () => {
    const reach = (s: string, seen = new Set<string>()): boolean => {
      if ((TERMINAL_STATUSES as readonly string[]).includes(s)) return true;
      if (seen.has(s)) return false;
      seen.add(s);
      return ORDER_TRANSITIONS.filter((t) => t.from === s).some((t) => reach(t.to, new Set(seen)));
    };
    for (const s of ORDER_STATUSES) expect(reach(s), s).toBe(true);
  });

  it("only the payment system can mark an order paid", () => {
    for (const actor of ["STUDENT", "SHOP_STAFF", "UNIVERSITY_ADMIN", "PLATFORM_ADMIN"] as const) {
      expect(() => assertTransition({ from: "AWAITING_PAYMENT", to: "PAID", actor, permissions: ["orders.accept"] })).toThrow(TransitionError);
    }
    expect(assertTransition({ from: "AWAITING_PAYMENT", to: "PAID", actor: "SYSTEM" }).to).toBe("PAID");
  });

  it("only the provider confirms refunds", () => {
    expect(() => assertTransition({ from: "REFUND_PENDING", to: "REFUNDED", actor: "PLATFORM_ADMIN" })).toThrow("may not");
  });

  it("requires the right shop permission", () => {
    expect(() => assertTransition({ from: "PAID", to: "ACCEPTED", actor: "SHOP_STAFF", permissions: ["orders.produce"] })).toThrow("orders.accept");
    expect(assertTransition({ from: "PAID", to: "ACCEPTED", actor: "SHOP_STAFF", permissions: ["orders.accept"] }).to).toBe("ACCEPTED");
  });

  it("requires reasons for rejections, failures and refunds", () => {
    let err: TransitionError | undefined;
    try {
      assertTransition({ from: "PAID", to: "REJECTED", actor: "SHOP_STAFF", permissions: ["orders.accept"], reason: " " });
    } catch (e) {
      err = e as TransitionError;
    }
    expect(err?.code).toBe("REASON_REQUIRED");
    expect(
      assertTransition({ from: "PRINTING", to: "PRINT_FAILED", actor: "SHOP_STAFF", permissions: ["orders.produce"], reason: "Paper jam on device 2" }).to,
    ).toBe("PRINT_FAILED");
  });

  it("rejects skipping production or QA", () => {
    expect(() => assertTransition({ from: "PAID", to: "READY_FOR_PICKUP", actor: "SHOP_STAFF", permissions: ["orders.qa"] })).toThrow("cannot move");
    expect(() => assertTransition({ from: "PRINTING", to: "READY_FOR_PICKUP", actor: "SHOP_STAFF", permissions: ["orders.qa"] })).toThrow("cannot move");
    expect(() => assertTransition({ from: "COLLECTED", to: "COLLECTED", actor: "SHOP_STAFF", permissions: ["orders.collect"] })).toThrow("cannot move");
  });

  it("lists actions for a role", () => {
    expect(allowedNextStatuses("PAID", "SHOP_STAFF", ["orders.accept"]).sort()).toEqual(["ACCEPTED", "REJECTED"]);
    expect(allowedNextStatuses("PAID", "SHOP_STAFF", [])).toEqual([]);
    expect(allowedNextStatuses("PAID", "STUDENT")).toEqual(["REFUND_PENDING"]);
  });

  it("defines cancellation eligibility", () => {
    expect(cancellationEligibility("AWAITING_PAYMENT")).toBe("CANCEL_NO_CHARGE");
    expect(cancellationEligibility("PAID")).toBe("CANCEL_WITH_REFUND");
    expect(cancellationEligibility("ACCEPTED")).toBe("NOT_ELIGIBLE");
    expect(cancellationEligibility("PRINTING")).toBe("NOT_ELIGIBLE");
  });
});
