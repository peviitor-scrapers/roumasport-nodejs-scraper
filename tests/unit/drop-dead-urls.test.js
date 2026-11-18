import { jest } from '@jest/globals';

// dropDeadUrls now does its own GET with a real AbortSignal timeout for jobs
// that were not fetched during the scrape. Mock node-fetch here so the tests
// stay offline and fast.
const mockFetch = jest.fn();

jest.unstable_mockModule('node-fetch', () => ({ default: mockFetch }));

const htmlResponse = (status, body = '<html><body>Job</body></html>') => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body
});

describe('dropDeadUrls', () => {
  let index;

  beforeAll(async () => {
    index = await import('../../scraper/index.js');
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('keeps active jobs and drops expired or erroring ones', async () => {
    mockFetch.mockImplementation(async (url) =>
      htmlResponse(url.includes('good') ? 200 : 404)
    );

    const jobs = [
      { url: 'https://x/good/', title: 'Good' },
      { url: 'https://x/bad/', title: 'Bad' }
    ];
    const kept = await index.dropDeadUrls(jobs);

    expect(kept.map(j => j.title)).toEqual(['Good']);
  });

  it('drops soft-404s whose HTTP status is 200', async () => {
    mockFetch.mockResolvedValue(
      htmlResponse(200, '<html>Sorry, this position is no longer available</html>')
    );

    const kept = await index.dropDeadUrls([{ url: 'https://x/old/', title: 'Old' }]);

    expect(kept).toEqual([]);
  });

  it('returns an empty array when every job fails live validation', async () => {
    mockFetch.mockResolvedValue(htmlResponse(404));

    const kept = await index.dropDeadUrls([{ url: 'https://x/1/', title: 'One' }]);

    expect(kept).toEqual([]);
  });
});
