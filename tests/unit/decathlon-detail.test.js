import { parseJobDetail } from "../../scraper/index.js";

const page = (jp) => `<html><head><script type="application/ld+json">${JSON.stringify(jp)}</script></head></html>`;

describe("parseJobDetail (cariere.decathlon.ro JSON-LD)", () => {
  test("reads title and region from JobPosting", () => {
    const html = page({
      "@type": "JobPosting",
      title: "Reprezentant V&#xE2;nz&#x103;ri Decathlon B&#x103;neasa",
      jobLocation: { address: { addressLocality: "Sector 1", addressRegion: "Bucuresti" } }
    });
    expect(parseJobDetail(html)).toEqual({ title: "Reprezentant Vânzări Decathlon Băneasa", city: "Bucuresti", expirationdate: undefined });
  });

  test("falls back to locality and reads validThrough", () => {
    const r = parseJobDetail(page({ "@type": "JobPosting", title: "Manager Departament", validThrough: "2026-12-31", jobLocation: { address: { addressLocality: "Bacau" } } }));
    expect(r.city).toBe("Bacau");
    expect(r.expirationdate).toBe(Date.parse("2026-12-31"));
  });

  test("returns nulls when there is no JobPosting", () => {
    expect(parseJobDetail("<html></html>")).toEqual({ title: null, city: null, expirationdate: undefined });
  });
});