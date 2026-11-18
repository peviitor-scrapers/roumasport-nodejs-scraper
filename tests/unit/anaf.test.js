import { jest } from '@jest/globals';

const mockFetch = jest.fn();

jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch
}));

function cuifirmaSearchResponse(results) {
  return {
    ok: true,
    json: async () => ({ results })
  };
}

function cuiscanCompanyResponse(data) {
  return {
    ok: true,
    json: async () => data
  };
}

function errorResponse(status) {
  return {
    ok: false,
    status,
    text: async () => 'Error'
  };
}

const LSEG_CUIFIRMA_RECORD = {
  cui: 39176747,
  name: 'LSEG BUSINESS SERVICES RM S.R.L.',
  statusLabel: 'Funcțiune'
};

const CUISCAN_RECORD = {
  cui: 39176747,
  denumire: 'LSEG BUSINESS SERVICES RM S.R.L.',
  adresa: 'IANCU DE HUNEDOARA, 48, Bucureşti Sectorul 1, Bucureşti',
  codCaen: '6220',
  activ: true,
  nrRegCom: 'J2014005735405',
  platitorTVA: true,
  stareInregistrare: 'INREGISTRAT din data 14.05.2014',
  adresaSediu: { strada: 'Bld. Iancu de Hunedoara', numar: '48', localitate: 'Sector 1 Mun. Bucureşti', judet: 'MUNICIPIUL BUCUREŞTI', codPostal: '11745' }
};

const CACHED_DATA = {
  cui: 39176747,
  name: 'LSEG BUSINESS SERVICES RM S.R.L.',
  address: 'MUNICIPIUL BUCUREŞTI, SECTOR 1, BLD IANCU DE HUNEDOARA, NR.48, ET.9',
  registrationNumber: 'J2014005735405',
  caenCode: '6220'
};

describe('scraper/anaf.js', () => {
  let anaf;

  beforeAll(async () => {
    anaf = await import('../../scraper/anaf.js');
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('searchCompany', () => {
    it('should return array of companies for valid brand', async () => {
      mockFetch.mockResolvedValue(cuifirmaSearchResponse([
        { cui: 39176747, name: 'LSEG BUSINESS SERVICES RM S.R.L.', is_active: true }
      ]));

      const results = await anaf.searchCompany('LSEG');

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('cui');
      expect(results[0]).toHaveProperty('name');
    });

    it('should return empty array for non-existent brand', async () => {
      mockFetch.mockResolvedValue(cuifirmaSearchResponse([]));

      const results = await anaf.searchCompany('NonExistentBrandXYZ123');

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });

    it('should include statusLabel in results', async () => {
      mockFetch.mockResolvedValue(cuifirmaSearchResponse([
        { cui: 39176747, name: 'LSEG BUSINESS SERVICES RM S.R.L.', status_label: 'Funcțiune' }
      ]));

      const results = await anaf.searchCompany('LSEG');

      expect(results[0]).toHaveProperty('statusLabel', 'Funcțiune');
    });

    it('should encode brand name in URL', async () => {
      let capturedUrl;
      mockFetch.mockImplementation((url) => {
        capturedUrl = url;
        return Promise.resolve(cuifirmaSearchResponse([]));
      });

      await anaf.searchCompany('LSEG SRL');
      expect(capturedUrl).toContain(encodeURIComponent('LSEG SRL'));
    });
  });

  describe('getCompanyFromANAF', () => {
    it('should return company data for valid CIF', async () => {
      mockFetch.mockResolvedValue(cuiscanCompanyResponse(CUISCAN_RECORD));

      const data = await anaf.getCompanyFromANAF('39176747');

      expect(data).toBeDefined();
      expect(data.cui).toBe(39176747);
      expect(data.name).toBe('LSEG BUSINESS SERVICES RM S.R.L.');
      expect(data).toHaveProperty('address');
      expect(data).toHaveProperty('registrationNumber');
    });

    it('should throw when CUIScan fails', async () => {
      mockFetch.mockResolvedValue(errorResponse(500));

      await expect(anaf.getCompanyFromANAF('39176747')).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should throw when CUIScan returns no data', async () => {
      mockFetch.mockResolvedValue(cuiscanCompanyResponse(null));

      await expect(anaf.getCompanyFromANAF('39176747')).rejects.toThrow();
    });
  });

  describe('getCompanyFromANAFWithFallback', () => {
    it('should return fresh data when API works', async () => {
      mockFetch.mockResolvedValue(cuiscanCompanyResponse(CUISCAN_RECORD));

      const data = await anaf.getCompanyFromANAFWithFallback('39176747');

      expect(data.name).toBe('LSEG BUSINESS SERVICES RM S.R.L.');
    });

    it('should use cached data when API fails', async () => {
      mockFetch.mockResolvedValue(errorResponse(500));

      const data = await anaf.getCompanyFromANAFWithFallback('39176747', CACHED_DATA);

      expect(data).toEqual(CACHED_DATA);
    });

    it('should throw when API fails and no cache available', async () => {
      mockFetch.mockResolvedValue(errorResponse(500));

      await expect(anaf.getCompanyFromANAFWithFallback('39176747')).rejects.toThrow();
    });
  });
});
