import { useCallback, useEffect, useRef, useState } from "react";
import {
  RESUME_ACCEPT,
  createResume,
  deleteResume,
  getResume,
  getResumeDownloadUrl,
  listResumes,
  updateResume,
  uploadResumeFile,
  type ResumeSummary,
  type ResumeUploadResult,
} from "../lib/api";
import { Button } from "./Button";

/**
 * Dashboard resume section: upload (drag and drop or browse), keep several
 * versions, pick the default Claude uses, and review or fix the extracted text
 * (which is exactly what Claude reads through the get_resume tool).
 */

type Notice = { tone: "ok" | "warn" | "error"; text: string };
type Editor = { id: string | null; label: string; content: string };

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

function labelFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return (base || "Resume").slice(0, 100);
}

function formatBytes(bytes: number | null): string | null {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const noticeStyles: Record<Notice["tone"], string> = {
  ok: "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/[0.08] text-amber-200",
  error: "border-accent/30 bg-accent/[0.08] text-accent",
};

const inputClass =
  "w-full bg-[#18181d] border border-white/[0.08] text-white px-4 py-2.5 rounded-xl text-sm " +
  "focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-all " +
  "placeholder:text-zinc-600 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]";

export function ResumeManager() {
  const [resumes, setResumes] = useState<ResumeSummary[] | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setResumes(await listResumes());
    } catch (e) {
      setResumes([]);
      setNotice({ tone: "error", text: `Could not load your resumes: ${errorText(e)}` });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const reportUpload = (fileName: string, result: ResumeUploadResult) => {
    const chars = result.resume.content?.length ?? 0;
    if (result.text_extracted) {
      setNotice({
        tone: "ok",
        text: `Uploaded ${fileName}. Claude can read ${chars.toLocaleString()} characters of text from it.`,
      });
    } else {
      setNotice({
        tone: "warn",
        text:
          `Uploaded ${fileName}, but no text could be read from it` +
          (result.extraction_error ? ` (${result.extraction_error})` : "") +
          `. Use "Edit text" to paste your resume so Claude can read it.`,
      });
    }
  };

  const upload = async (files: FileList | null, resumeId?: string) => {
    const file = files?.[0];
    if (!file) return;
    setNotice(null);
    if (resumeId) setBusyId(resumeId);
    else setUploading(true);
    try {
      const result = await uploadResumeFile(file, {
        resumeId,
        label: resumeId ? undefined : newLabel.trim() || labelFromFileName(file.name),
      });
      reportUpload(file.name, result);
      if (!resumeId) setNewLabel("");
      if (editor?.id === resumeId) setEditor(null);
      await refresh();
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e) });
    } finally {
      setUploading(false);
      setBusyId(null);
    }
  };

  const runRowAction = async (id: string, action: () => Promise<void>) => {
    setNotice(null);
    setBusyId(id);
    try {
      await action();
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusyId(null);
    }
  };

  const makeDefault = (r: ResumeSummary) =>
    runRowAction(r.id, async () => {
      await updateResume(r.id, { is_default: true });
      await refresh();
    });

  const openEditor = (r: ResumeSummary) =>
    runRowAction(r.id, async () => {
      const full = await getResume(r.id);
      setEditor({ id: r.id, label: full.label, content: full.content ?? "" });
    });

  const download = (r: ResumeSummary) =>
    runRowAction(r.id, async () => {
      const { url } = await getResumeDownloadUrl(r.id);
      window.open(url, "_blank", "noopener");
    });

  const remove = (r: ResumeSummary) => {
    if (!window.confirm(`Delete "${r.label}"? Its file and text are removed too.`)) return;
    runRowAction(r.id, async () => {
      await deleteResume(r.id);
      if (editor?.id === r.id) setEditor(null);
      await refresh();
    });
  };

  const chooseReplacement = (r: ResumeSummary) => {
    replaceTarget.current = r.id;
    replaceInput.current?.click();
  };

  const saveEditor = async () => {
    if (!editor) return;
    const label = editor.label.trim() || "Resume";
    const content = editor.content.trim() ? editor.content : null;
    setSaving(true);
    setNotice(null);
    try {
      if (editor.id) await updateResume(editor.id, { label, content });
      else await createResume({ label, content: content ?? undefined });
      setEditor(null);
      setNotice({ tone: "ok", text: `Saved "${label}".` });
      await refresh();
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  const editorPanel = editor && (
    <div className="rounded-xl border border-accent/30 bg-[#141419] p-5 space-y-4" id="resume-editor">
      <div>
        <label htmlFor="resume-editor-label" className="block text-xs text-zinc-400 uppercase tracking-wider mb-2 font-medium">
          Name
        </label>
        <input
          id="resume-editor-label"
          value={editor.label}
          maxLength={100}
          onChange={(e) => setEditor({ ...editor, label: e.target.value })}
          className={inputClass}
          placeholder="e.g. Full-stack"
        />
      </div>
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <label htmlFor="resume-editor-content" className="text-xs text-zinc-400 uppercase tracking-wider font-medium">
            Resume text
          </label>
          <span className="text-[11px] font-mono text-zinc-500">
            {editor.content.length.toLocaleString()} characters
          </span>
        </div>
        <textarea
          id="resume-editor-content"
          value={editor.content}
          onChange={(e) => setEditor({ ...editor, content: e.target.value })}
          rows={14}
          className={`${inputClass} font-mono text-xs leading-relaxed resize-y`}
          placeholder="Paste your resume here."
        />
        <p className="text-xs text-zinc-500 mt-2">
          This is exactly what Claude reads. Fix anything the extraction got wrong.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button id="resume-editor-save" onClick={saveEditor} loading={saving} variant="primary" size="sm">
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button id="resume-editor-cancel" onClick={() => setEditor(null)} variant="ghost" size="sm" disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <div className="md:col-span-2 rounded-2xl border border-white/[0.08] bg-[#121216] overflow-hidden" id="resume-section">
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-white/[0.02]">
        <span className="text-xs text-accent font-bold uppercase tracking-wider">Profile</span>
        <span className="text-[11px] font-mono text-zinc-500">PDF · DOCX · TXT · MD · up to 10 MB</span>
      </div>

      <div className="p-6 space-y-5">
        <div>
          <h3 className="text-lg font-bold uppercase tracking-tight text-white mb-1">Resume</h3>
          <p className="text-zinc-400 text-sm leading-relaxed max-w-2xl">
            Claude reads the text of your default resume when it fills in applications. Keep
            separate versions for different kinds of roles and set the one to use by default.
          </p>
        </div>

        {/* Upload */}
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <input
              id="resume-new-label"
              value={newLabel}
              maxLength={100}
              onChange={(e) => setNewLabel(e.target.value)}
              className={`${inputClass} sm:max-w-xs`}
              placeholder="Name this version (optional)"
              aria-label="Name for the uploaded resume"
              disabled={uploading}
            />
            <Button
              id="resume-paste"
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={() => setEditor({ id: null, label: newLabel.trim() || "Resume", content: "" })}
            >
              Or paste text instead
            </Button>
          </div>

          <label
            id="resume-dropzone"
            onDragOver={(e) => {
              e.preventDefault();
              if (!uploading) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!uploading) upload(e.dataTransfer.files);
            }}
            className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
              uploading
                ? "border-white/[0.12] bg-white/[0.02] cursor-wait"
                : dragging
                  ? "border-accent bg-accent/[0.06] cursor-copy"
                  : "border-white/[0.12] hover:border-accent/50 hover:bg-white/[0.02] cursor-pointer"
            }`}
          >
            <input
              type="file"
              accept={RESUME_ACCEPT}
              className="sr-only"
              disabled={uploading}
              onChange={(e) => {
                upload(e.target.files);
                e.target.value = "";
              }}
            />
            {uploading ? (
              <>
                <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-zinc-300">Uploading and reading your resume…</p>
              </>
            ) : (
              <>
                <svg className="w-6 h-6 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
                <p className="text-sm text-zinc-300">
                  Drop your resume here or <span className="text-accent font-medium">browse</span>
                </p>
                <p className="text-xs text-zinc-500">PDF or Word works best. The text is pulled out so Claude can read it.</p>
              </>
            )}
          </label>
        </div>

        {notice && (
          <div
            id="resume-notice"
            role={notice.tone === "error" ? "alert" : "status"}
            className={`text-xs rounded-xl border px-4 py-3 ${noticeStyles[notice.tone]}`}
          >
            {notice.text}
          </div>
        )}

        {editor && editor.id === null && editorPanel}

        {/* Versions */}
        {resumes === null ? (
          <div className="flex items-center gap-3 text-zinc-400 text-sm py-2">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            Loading your resumes…
          </div>
        ) : (
          resumes.length > 0 && (
            <ul className="space-y-3" id="resume-list">
              {resumes.map((r) => {
                const busy = busyId === r.id;
                const meta = [r.file_name, formatBytes(r.file_size_bytes), `Updated ${formatDate(r.updated_at)}`]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li key={r.id} className="space-y-3">
                    <div className="rounded-xl border border-white/[0.08] bg-[#17171d] p-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-white font-semibold truncate">{r.label}</span>
                          {r.is_default && (
                            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent/[0.12] text-accent border border-accent/30">
                              Default
                            </span>
                          )}
                        </div>
                        <p className="text-xs font-mono text-zinc-500 truncate">{meta}</p>
                        <p className="text-xs flex items-center gap-1.5">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${r.content_chars > 0 ? "bg-emerald-400" : "bg-amber-400"}`}
                          />
                          {r.content_chars > 0 ? (
                            <span className="text-zinc-400">
                              Text ready · {r.content_chars.toLocaleString()} characters
                            </span>
                          ) : (
                            <span className="text-amber-200">No text yet. Add it with Edit text.</span>
                          )}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
                        {busy && (
                          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                        )}
                        {!r.is_default && (
                          <Button variant="secondary" size="sm" disabled={busy} onClick={() => makeDefault(r)}>
                            Make default
                          </Button>
                        )}
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => openEditor(r)}>
                          Edit text
                        </Button>
                        {r.file_name && (
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => download(r)}>
                            Download
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => chooseReplacement(r)}>
                          {r.file_name ? "Replace file" : "Upload file"}
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(r)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                    {editor?.id === r.id && editorPanel}
                  </li>
                );
              })}
            </ul>
          )
        )}

        <input
          ref={replaceInput}
          type="file"
          accept={RESUME_ACCEPT}
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const id = replaceTarget.current;
            if (id) upload(e.target.files, id);
            replaceTarget.current = null;
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
