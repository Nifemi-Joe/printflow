export interface NavItem {
  href: string;
  label: string;
}

/**
 * The platform workspace's navigation, declared once.
 *
 * Every page in a workspace passes the same list to AppShell, so when each one
 * wrote its own copy they drifted: a page added later was missing from the
 * navigation of every page that already existed, and the only symptom was a
 * link that quietly did not appear. One list means adding a page here puts it
 * in the navigation of all of them.
 */
export const PLATFORM_NAV: NavItem[] = [
  { href: "/platform", label: "Universities and health" },
  { href: "/platform/enquiries", label: "Enquiries" },
];
