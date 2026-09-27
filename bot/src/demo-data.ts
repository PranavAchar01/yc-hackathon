/**
 * Fictional demo data from SPEC.md. Every name, company and address here is made up.
 * Recipients are @example.com so nothing could ever reach a real inbox.
 */

export interface EmailDraft {
  to: string;
  toName: string;
  company: string;
  subject: string;
  body: string;
  attachment: string;
}

export const WORKSPACE = "Northwind";
export const REQUESTER = "Priya";

const CONTACTS: ReadonlyArray<{
  name: string;
  company: string;
  segment: "enterprise" | "startup" | "agency";
}> = [
  { name: "Dana Whitfield", company: "Contoso", segment: "enterprise" },
  { name: "Leo Marsh", company: "Fabrikam", segment: "enterprise" },
  { name: "Ana Ortiz", company: "Tailspin", segment: "startup" },
  { name: "Sam Okafor", company: "Litware", segment: "startup" },
  { name: "Mei Tanaka", company: "Adatum", segment: "enterprise" },
  { name: "Ravi Menon", company: "Proseware", segment: "startup" },
  { name: "Clara Novak", company: "Wingtip", segment: "agency" },
  { name: "Owen Brooks", company: "Coho", segment: "agency" },
  { name: "Isla Grant", company: "Fourth Coffee", segment: "startup" },
  { name: "Jonah Reyes", company: "Lucerne", segment: "enterprise" },
  { name: "Nora Kim", company: "Humongous", segment: "agency" },
  { name: "Theo Park", company: "Relecloud", segment: "startup" },
];

const ONE_PAGERS = {
  enterprise: "Northwind-Launch-Enterprise.pdf",
  startup: "Northwind-Launch-Startups.pdf",
  agency: "Northwind-Launch-Agencies.pdf",
} as const;

function emailFor(name: string): string {
  return `${name.split(" ")[0]?.toLowerCase() ?? "contact"}@example.com`;
}

export function demoDrafts(sender = "Mark"): EmailDraft[] {
  return CONTACTS.map((c) => {
    const first = c.name.split(" ")[0] ?? c.name;
    return {
      to: emailFor(c.name),
      toName: c.name,
      company: c.company,
      subject: `Northwind launches today, ${first}`,
      body: [
        `Hi ${first},`,
        `We just launched the new Northwind workspace. I put together a one-pager for teams like ${c.company}, and the launch video is two minutes long.`,
        "Happy to walk you through it this week if useful.",
        sender,
      ].join("\n\n"),
      attachment: ONE_PAGERS[c.segment],
    };
  });
}

export const LAUNCH_VIDEO_URL = "https://example.com/northwind-launch";
