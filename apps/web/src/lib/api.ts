import { config } from '../config';
import type { Job, Sample, Ticket } from '../types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type TokenGetter = () => Promise<string | undefined>;

/** Thin client for the API; every call carries the user's access token. */
export function createApi(getToken: TokenGetter) {
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const token = await getToken();
    const res = await fetch(`${config.apiUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new ApiError(res.status, body.error?.code ?? 'HTTP_ERROR', body.error?.message ?? `Request failed (${res.status}).`);
    }
    return res;
  };

  return {
    listJobs: async () => ((await (await request('/jobs')).json()) as { jobs: Job[] }).jobs,
    getJob: async (id: string) => (await (await request(`/jobs/${id}`)).json()) as Job,
    createJob: async (file: File, ticket: Ticket) => {
      const form = new FormData();
      form.set('file', file);
      form.set('ticket', JSON.stringify(ticket));
      return (await (await request('/jobs', { method: 'POST', body: form })).json()) as Job;
    },
    report: async (id: string) => (await request(`/jobs/${id}/report`)).text(),
    /** The preview needs the token, so it is fetched and shown from a blob URL. */
    artworkUrl: async (id: string) => URL.createObjectURL(await (await request(`/jobs/${id}/artwork`)).blob()),
    samples: async () => ((await (await request('/samples')).json()) as { samples: Sample[] }).samples,
    sampleFile: async (s: Sample) => new File([await (await request(`/samples/${s.id}/file`)).blob()], s.file.split('/').pop()!, { type: 'image/jpeg' }),
    eventsUrl: (id: string) => `${config.apiUrl}/jobs/${id}/events`,
  };
}

export type Api = ReturnType<typeof createApi>;
