import { jest } from '@jest/globals';
import fs from 'fs';

const mockFetch = jest.fn();

jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch
}));

const COMPANY_JSON_PATH = 'tmp/company.json';
const ROOT_COMPANY_JSON_PATH = 'company.json';

function backupFile(path) {
  if (fs.existsSync(path)) {
    fs.renameSync(path, `${path}.bak`);
  }
}

function restoreFile(path) {
  if (fs.existsSync(`${path}.bak`)) {
    fs.renameSync(`${path}.bak`, path);
  }
}

function clearAllCaches() {
  for (const p of [COMPANY_JSON_PATH, ROOT_COMPANY_JSON_PATH]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function cuiscanCompanyResponse(data) {
  return {
    ok: true,
    json: async () => data
  };
}

function peviitorResponse(companies) {
  return {
    ok: true,
    json: async () => ({ companies })
  };
}

function solrResponse(total, data) {
  return {
    ok: true,
    json: async () => ({ total, data })
  };
}

const EXAMPLE_CUISCAN_RECORD = {
  cui: 12345678,
  denumire: 'EXAMPLE COMPANY SRL',
  adresa: 'STR. EXAMPLE, NR.1, LOCALITATE',
  codCaen: '0000',
  platitorTVA: true,
  eFacturaRegistered: false,
  headquartersAddress: { localitate: 'Iași' }
};

describe('company.js', () => {
  let company;

  beforeAll(async () => {
    fs.mkdirSync("tmp", { recursive: true });
    backupFile(COMPANY_JSON_PATH);
    backupFile(ROOT_COMPANY_JSON_PATH);
    company = await import('../../scraper/company.js');
  });

  afterAll(() => {
    restoreFile(COMPANY_JSON_PATH);
    restoreFile(ROOT_COMPANY_JSON_PATH);
  });

  beforeEach(() => {
    mockFetch.mockReset();
    clearAllCaches();
  });

  describe('getCompanyData (no cache)', () => {
    it('should fetch the company via direct CIF lookup and return company data', async () => {
      mockFetch.mockResolvedValueOnce(cuiscanCompanyResponse(EXAMPLE_CUISCAN_RECORD));

      const result = await company.getCompanyData();

      expect(result).toHaveProperty('company', 'EXAMPLE COMPANY SRL');
      expect(result).toHaveProperty('cif', '12345678');
      expect(result).toHaveProperty('anafData');
      expect(result.anafData.name).toBe('EXAMPLE COMPANY SRL');
    });

    it('should throw when CUIScan returns no data', async () => {
      mockFetch.mockResolvedValueOnce(cuiscanCompanyResponse(null));

      await expect(company.getCompanyData()).rejects.toThrow('CUIScan returned no data');
    });

    it('should throw when CUIScan returns no company name', async () => {
      mockFetch.mockResolvedValueOnce(cuiscanCompanyResponse({ cui: 12345678, denumire: null }));

      await expect(company.getCompanyData()).rejects.toThrow('CUIScan returned no company name');
    });
  });

  describe('getCompanyData (with cache)', () => {
    const cachedData = {
      validatedAt: new Date().toISOString(),
      anaf: { ...EXAMPLE_CUISCAN_RECORD, name: EXAMPLE_CUISCAN_RECORD.denumire },
      summary: {
        company: 'EXAMPLE COMPANY SRL',
        cif: '12345678'
      }
    };

    beforeEach(() => {
      fs.writeFileSync(COMPANY_JSON_PATH, JSON.stringify(cachedData), 'utf-8');
    });

    it('should use cached company data when available', async () => {
      const result = await company.getCompanyData();

      expect(result.company).toBe('EXAMPLE COMPANY SRL');
      expect(result.cif).toBe('12345678');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('validateAndGetCompany', () => {
    afterEach(() => {
      clearAllCaches();
    });

    it('should return company identity and existing job count', async () => {
      mockFetch
        .mockResolvedValueOnce(cuiscanCompanyResponse(EXAMPLE_CUISCAN_RECORD))
        .mockResolvedValueOnce(solrResponse(5, [
          { url: 'https://test.com/1', title: 'Job 1' },
          { url: 'https://test.com/2', title: 'Job 2' }
        ]))
        .mockResolvedValueOnce(peviitorResponse([{ company: 'EXAMPLE COMPANY SRL' }]));

      const result = await company.validateAndGetCompany();

      expect(result).toHaveProperty('company', 'EXAMPLE COMPANY SRL');
      expect(result).toHaveProperty('cif', '12345678');
      expect(result).toHaveProperty('existingJobsCount');
      expect(typeof result.existingJobsCount).toBe('number');
    });
  });
});
