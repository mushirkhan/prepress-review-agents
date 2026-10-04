import { type FormEvent, useEffect, useState } from 'react';
import { VerdictChip } from '../components/Verdict';
import { config } from '../config';
import { ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import type { Sample, Ticket } from '../types';

const PRESETS = [
  { id: 'card', label: 'Business card', w: 85, h: 55 },
  { id: 'a6', label: 'A6 flyer', w: 105, h: 148 },
  { id: 'label', label: 'Product label', w: 100, h: 70 },
] as const;

interface Form {
  jobName: string;
  trimWidthMm: string;
  trimHeightMm: string;
  bleedMm: string;
  minDpi: string;
  colorMode: 'CMYK' | 'RGB';
  barcode: string;
  licenceReference: string;
}

const EMPTY: Form = { jobName: 'Business card', trimWidthMm: '85', trimHeightMm: '55', bleedMm: '3', minDpi: '300', colorMode: 'CMYK', barcode: '', licenceReference: '' };

const GROUPS: { id: Sample['category']; title: string }[] = [
  { id: 'approve', title: 'Should be approved' },
  { id: 'reject', title: 'Should be rejected' },
  { id: 'needs-human', title: 'Should go to a person' },
  { id: 'invalid', title: 'Invalid uploads' },
];

function toTicket(f: Form): Ticket {
  return {
    jobName: f.jobName.trim(),
    trimWidthMm: Number(f.trimWidthMm),
    trimHeightMm: Number(f.trimHeightMm),
    bleedMm: Number(f.bleedMm),
    minDpi: Number(f.minDpi),
    colorMode: f.colorMode,
    ...(f.barcode.trim() ? { barcode: f.barcode.trim() } : {}),
    ...(f.licenceReference.trim() ? { licenceReference: f.licenceReference.trim() } : {}),
  };
}

export function NewReview() {
  const { api } = useSession();
  const [form, setForm] = useState<Form>(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [chosen, setChosen] = useState<Sample | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    api.samples().then(setSamples).catch(() => setSamples([]));
  }, [api]);

  useEffect(() => {
    if (!file || !file.size) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const pickFile = (f: File | undefined) => {
    setError(null);
    setChosen(null);
    setFile(f ?? null);
  };

  const useSample = async (s: Sample) => {
    setError(null);
    try {
      setFile(await api.sampleFile(s));
      setChosen(s);
      setForm({
        ...EMPTY,
        jobName: s.ticket.jobName,
        trimWidthMm: String(s.ticket.trimWidthMm),
        trimHeightMm: String(s.ticket.trimHeightMm),
        barcode: s.ticket.barcode ?? '',
        licenceReference: s.ticket.licenceReference ?? '',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError('Choose an artwork file or a sample first.');
    setBusy(true);
    setError(null);
    try {
      const job = await api.createJob(file, toTicket(form));
      navigate(`/jobs/${job.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} (${err.status} ${err.code})` : String(err));
      setBusy(false);
    }
  };

  const tooBig = file && file.size > config.maxUploadBytes;

  return (
    <div className="page">
      <header className="page-head">
        <h1>New review</h1>
        <p className="lede">Upload print artwork with its job ticket. The orchestrator hands it to the Preflight and IP &amp; Trademark agents, then the Report agent writes up the verdict. You can watch every step live.</p>
      </header>

      <div className="new-grid">
        <form className="card" onSubmit={submit}>
          <label
            className={`drop ${dragging ? 'drop-active' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pickFile(e.dataTransfer.files[0]);
            }}
          >
            <input id="file" type="file" accept="image/jpeg,image/png,image/tiff" onChange={(e) => pickFile(e.target.files?.[0])} />
            {preview ? <img src={preview} alt="Artwork preview" /> : <span>Drop artwork here or choose a file</span>}
            <small>
              {file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : 'JPEG, PNG or TIFF, 200 KB or less'}
              {tooBig ? ' · over the limit, the server will refuse it' : ''}
            </small>
          </label>

          {chosen ? (
            <p className="expected">
              Sample: {chosen.description} Expected:{' '}
              {chosen.expected.verdict ? <VerdictChip verdict={chosen.expected.verdict} /> : <code>HTTP {chosen.expected.httpStatus} {chosen.expected.error}</code>}
              {chosen.expected.issueCodes?.map((c) => (
                <code key={c}> {c}</code>
              ))}
            </p>
          ) : null}

          <fieldset>
            <legend>Job ticket</legend>
            <div className="presets" role="group" aria-label="Size presets">
              {PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`preset ${form.trimWidthMm === String(p.w) && form.trimHeightMm === String(p.h) ? 'preset-on' : ''}`}
                  onClick={() => setForm({ ...form, jobName: p.label, trimWidthMm: String(p.w), trimHeightMm: String(p.h) })}
                >
                  {p.label}
                  <small>
                    {p.w} × {p.h} mm
                  </small>
                </button>
              ))}
            </div>
            <div className="fields">
              <label>
                Job name
                <input id="jobName" value={form.jobName} onChange={set('jobName')} required maxLength={100} />
              </label>
              <label>
                Trim width (mm)
                <input id="trimWidth" type="number" min="1" step="0.1" value={form.trimWidthMm} onChange={set('trimWidthMm')} required />
              </label>
              <label>
                Trim height (mm)
                <input id="trimHeight" type="number" min="1" step="0.1" value={form.trimHeightMm} onChange={set('trimHeightMm')} required />
              </label>
              <label>
                Bleed (mm)
                <input id="bleed" type="number" min="0" max="10" step="0.5" value={form.bleedMm} onChange={set('bleedMm')} />
              </label>
              <label>
                Minimum DPI
                <input id="minDpi" type="number" min="72" max="1200" value={form.minDpi} onChange={set('minDpi')} />
              </label>
              <label>
                Colour mode
                <select id="colorMode" value={form.colorMode} onChange={set('colorMode')}>
                  <option>CMYK</option>
                  <option>RGB</option>
                </select>
              </label>
              <label>
                Barcode (EAN-13, optional)
                <input id="barcode" inputMode="numeric" pattern="\d{13}" value={form.barcode} onChange={set('barcode')} placeholder="13 digits" />
              </label>
              <label>
                Licence reference (optional)
                <input id="licence" value={form.licenceReference} onChange={set('licenceReference')} placeholder="For licensed brands" />
              </label>
            </div>
          </fieldset>

          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Uploading…' : 'Start review'}
          </button>
        </form>

        <aside className="card samples">
          <h2>Try a sample</h2>
          <p className="muted">Generated artwork with known results. Brand names appear as plain text only.</p>
          {GROUPS.map((g) => (
            <div key={g.id} className="sample-group">
              <h3>{g.title}</h3>
              {samples
                .filter((s) => s.category === g.id)
                .map((s) => (
                  <button type="button" key={s.id} className={`sample ${chosen?.id === s.id ? 'sample-on' : ''}`} onClick={() => void useSample(s)}>
                    <span>{s.description}</span>
                    <code>{s.id}</code>
                  </button>
                ))}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
