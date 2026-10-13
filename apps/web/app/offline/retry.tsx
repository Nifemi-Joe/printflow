"use client";

export function RetryButton() {
  return (
    <button className="btn btn-primary" style={{ width: "100%" }} onClick={() => window.location.reload()}>
      Try again
    </button>
  );
}
