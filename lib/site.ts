export const siteConfig = {
  name: "Lab Lords",
  shortName: "Lab Lords",
  homeTitle: "Lab Lords — Study Hall & Library Management Software",
  description: "Manage seats, shifts, students, fees, dues, staff, and branches for study halls, libraries, coaching centres, and tuition centres in India.",
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? "https://lablords.in").replace(/\/$/, ""),
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "lablords.in@gmail.com",
  businessAddress: process.env.NEXT_PUBLIC_BUSINESS_ADDRESS?.trim() || "Business address available on request",
};

export function absoluteUrl(path = "/") {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${siteConfig.url}${normalizedPath}`;
}
