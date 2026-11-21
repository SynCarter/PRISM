import React, { useState } from 'react';
import { ProjectJob } from '../types';
import { Interactive3DModal } from './Interactive3DModal';
import { getProjectSpzUrl, downloadSpzFile } from '../lib/spzDownloader';

interface ProjectDetailProps {
  project: ProjectJob;
  onBackToProjects: () => void;
}

export const ProjectDetail: React.FC<ProjectDetailProps> = ({ project, onBackToProjects }) => {
  const [show3DModal, setShow3DModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isDownloadingSpz, setIsDownloadingSpz] = useState(false);

  const shareUrl = project.shareUrl || `https://prism.app/share/${project.id}`;

  const handleDownloadSpz = async () => {
    setIsDownloadingSpz(true);
    try {
      const url = await getProjectSpzUrl(project.id, project.modelPath);
      if (url) {
        await downloadSpzFile(url, `${project.name || 'reconstruction'}.spz`);
      } else {
        alert(`No .spz model was found in Supabase for "${project.name}".`);
      }
    } catch (err: unknown) {
      console.error('Failed to download SPZ:', err);
      const msg = err instanceof Error ? err.message : 'Download failed';
      alert(`Could not download SPZ: ${msg}`);
    } finally {
      setIsDownloadingSpz(false);
    }
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
  };

  return (
    <div className="min-h-screen bg-[#0b0e14] text-slate-200 antialiased flex flex-col pb-20 selection:bg-orange-500/30">
      <main className="flex-1 max-w-[1360px] w-full mx-auto px-6 py-6 md:py-8 space-y-6">
        {/* Sub-navigation: Back to projects */}
        <nav aria-label="Breadcrumb">
          <button
            onClick={onBackToProjects}
            className="inline-flex items-center text-xs font-normal text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5 mr-1.5 stroke-[1.8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" strokeLinecap="round" strokeLinejoin="round"></path>
            </svg>
            <span>Back to Projects</span>
          </button>
        </nav>

        {/* Page Title & Meta Details */}
        <div className="space-y-3">
          <h1 className="text-3xl font-bold text-white tracking-tight">{project.name}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
            {/* Date */}
            <div className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect height="18" rx="2" strokeWidth="1.8" width="18" x="3" y="4"></rect>
                <path d="M16 2v4M8 2v4M3 10h18" strokeWidth="1.8"></path>
              </svg>
              <span>{project.dateCreated}</span>
            </div>
            <span className="text-slate-700">|</span>

            {/* Photograph count */}
            <div className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect height="18" rx="2" strokeWidth="1.8" width="18" x="3" y="3"></rect>
                <circle cx="8.5" cy="8.5" r="1.5" strokeWidth="1.8"></circle>
                <path d="M21 15l-5-5L5 21" strokeWidth="1.8"></path>
              </svg>
              <span>{project.photographsCount} photographs</span>
            </div>
            <span className="text-slate-700">|</span>

            {/* Project ID */}
            <div className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" strokeWidth="1.8"></circle>
                <path d="M12 7v5l3 2" strokeWidth="1.8"></path>
              </svg>
              <span>
                Project ID: <span className="font-mono text-slate-300">{project.id}</span>
              </span>
            </div>
          </div>
        </div>

        {/* Main Grid: 2 Columns for top cards, 2 Columns for bottom cards */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Card 1: Reconstruction Status Card */}
          <section className="lg:col-span-6 bg-[#121720] border border-[#1f2633] rounded-xl p-6 shadow-xl">
            <div className="flex items-center justify-between mb-7">
              <h2 className="text-base font-medium text-white tracking-tight">Reconstruction Status</h2>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#133024] border border-[#1b4e38] text-[#34d399] text-xs font-medium">
                <svg className="w-3.5 h-3.5 text-[#34d399]" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    clipRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
                    fillRule="evenodd"
                  ></path>
                </svg>
                <span>Completed</span>
              </div>
            </div>

            {/* Stepper Timeline */}
            <div className="relative pl-1">
              {[
                { title: 'Photographs uploaded', desc: 'Your images have been stored successfully.' },
                { title: 'Preparing reconstruction', desc: 'Setting up the reconstruction process.' },
                { title: 'Reconstructing spatial structure', desc: 'Analysing your photographs to build the 3D structure.' },
                { title: 'Generating 3D model', desc: 'Creating the Gaussian Splatting representation.' },
                { title: 'Finalizing', desc: 'Preparing your digital twin for viewing.' }
              ].map((step, idx, arr) => (
                <div key={step.title} className="relative flex items-start gap-4">
                  <div className="flex flex-col items-center">
                    <div className="w-6 h-6 rounded-full bg-[#f89538] flex items-center justify-center text-[#0b0e14] shrink-0">
                      <svg className="w-3.5 h-3.5 stroke-[2.5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path d="M4.5 12.75l6 6 9-13.5" strokeLinecap="round" strokeLinejoin="round"></path>
                      </svg>
                    </div>
                    {idx < arr.length - 1 && <div className="w-[2px] h-8 bg-[#f89538]"></div>}
                  </div>
                  <div className="pt-0.5 pb-2">
                    <h3 className="text-sm font-medium text-white">{step.title}</h3>
                    <p className="text-xs text-slate-400 mt-0.5">{step.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Card 2: 3D Model Card (Redirects to full SPZ flight viewer) */}
          <section className="lg:col-span-6 bg-[#121720] border border-[#1f2633] rounded-xl p-4 sm:p-5 flex flex-col justify-between shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-xs text-[#ea580c] uppercase tracking-wider font-semibold flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#ea580c] animate-ping"></span>
                SPZ 3D Model
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isDownloadingSpz}
                  onClick={handleDownloadSpz}
                  className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-mono text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                  title="Download .spz file"
                >
                  {isDownloadingSpz ? (
                    <>
                      <div className="w-3 h-3 rounded-full border-2 border-[#ea580c]/30 border-t-[#ea580c] animate-spin"></div>
                      <span>Downloading...</span>
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-sm text-[#ea580c]">download</span>
                      <span>Download SPZ</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShow3DModal(true)}
              onMouseMove={handleMouseMove}
              className="block w-full overflow-hidden rounded-lg bg-[#07090e] relative aspect-[16/10] border border-[#ea580c]/30 hover:border-[#ea580c] group select-none transition-all shadow-inner"
              title="Launch interactive 3D flight viewer"
            >
              {/* Base subtle dot grid */}
              <div
                className="absolute inset-0 pointer-events-none transition-opacity duration-300 opacity-40 group-hover:opacity-75"
                style={{
                  backgroundImage: 'radial-gradient(rgba(255, 255, 255, 0.18) 1px, transparent 1px)',
                  backgroundSize: '20px 20px',
                  backgroundPosition: 'center'
                }}
              ></div>

              {/* Cursor spotlight */}
              <div
                className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300 mix-blend-screen"
                style={{
                  backgroundImage: 'radial-gradient(rgba(255, 170, 85, 0.75) 1.5px, transparent 1.5px)',
                  backgroundSize: '20px 20px',
                  backgroundPosition: 'center',
                  WebkitMaskImage: `radial-gradient(220px 220px at ${mousePos.x}px ${mousePos.y}px, black 20%, transparent 80%)`,
                  maskImage: `radial-gradient(220px 220px at ${mousePos.x}px ${mousePos.y}px, black 20%, transparent 80%)`
                }}
              ></div>

              {/* Radial glow */}
              <div
                className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                style={{
                  background: `radial-gradient(350px circle at ${mousePos.x}px ${mousePos.y}px, rgba(249, 150, 57, 0.16), rgba(255, 122, 41, 0.05) 50%, transparent 80%)`
                }}
              ></div>

              <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_80px_rgba(0,0,0,0.8)]"></div>

              {/* Centered Content */}
              <div className="relative z-10 w-full h-full flex flex-col items-center justify-center gap-3 backdrop-blur-[1px] p-6 text-center">
                <div className="w-14 h-14 rounded-full bg-[#161c26]/90 border border-white/10 flex items-center justify-center text-[#ea580c] group-hover:scale-110 group-hover:border-[#ea580c]/60 group-hover:shadow-[0_0_25px_rgba(234,88,12,0.4)] transition-all">
                  <span className="material-symbols-outlined text-2xl">flight</span>
                </div>
                <div>
                  <div className="flex items-center justify-center gap-2 text-sm sm:text-base font-semibold text-slate-100 group-hover:text-white transition-colors">
                    <span>View 3D Model</span>
                    <span className="text-[#ea580c] transition-transform group-hover:translate-x-1.5 text-lg">→</span>
                  </div>
                  <p className="text-slate-400 text-xs font-mono mt-1">
                    Opens SPZ flight viewer ready to explore
                  </p>
                </div>
              </div>
            </button>
          </section>

          {/* Card 3: Project Details Card */}
          <section className="lg:col-span-6 bg-[#121720] border border-[#1f2633] rounded-xl p-6 shadow-xl">
            <h2 className="text-base font-medium text-white mb-5">Project Details</h2>
            <div className="space-y-3.5 text-xs">
              <div className="grid grid-cols-12 items-baseline">
                <span className="col-span-4 text-slate-400">Created</span>
                <span className="col-span-8 text-slate-200">{project.dateCreated}</span>
              </div>
              <div className="grid grid-cols-12 items-baseline">
                <span className="col-span-4 text-slate-400">Photographs</span>
                <span className="col-span-8 text-slate-200">{project.photographsCount}</span>
              </div>
              <div className="grid grid-cols-12 items-baseline">
                <span className="col-span-4 text-slate-400">Status</span>
                <div className="col-span-8 flex items-center gap-1.5 text-emerald-400">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      clipRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
                      fillRule="evenodd"
                    ></path>
                  </svg>
                  <span className="font-normal text-emerald-400">Completed</span>
                </div>
              </div>
              <div className="grid grid-cols-12 items-baseline">
                <span className="col-span-4 text-slate-400">Model Format</span>
                <span className="col-span-8 text-slate-200 font-mono">{project.modelFormat || '3D Gaussian Splat (.spz)'}</span>
              </div>
              <div className="grid grid-cols-12 items-baseline">
                <span className="col-span-4 text-slate-400">Model Path</span>
                <span className="col-span-8 text-slate-200 font-mono text-[11px] truncate">
                  {project.modelPath || `models/${project.id}/splat_high_res.spz`}
                </span>
              </div>
            </div>
          </section>

          {/* Card 4: Share Project Card */}
          <section className="lg:col-span-6 bg-[#121720] border border-[#1f2633] rounded-xl p-6 shadow-xl">
            <h2 className="text-base font-medium text-white">Share Project</h2>
            <p className="text-xs text-slate-400 mt-1 mb-5">Share this reconstructed space with others using a link.</p>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <div className="relative flex-1">
                <input
                  type="text"
                  readOnly
                  value={shareUrl}
                  className="w-full bg-[#0a0d12] border border-white/10 rounded-lg px-3.5 py-2.5 text-xs font-mono text-slate-300 focus:outline-none focus:border-slate-500 transition-colors"
                />
              </div>
              <button
                type="button"
                onClick={handleCopyLink}
                className="px-4 py-2.5 bg-[#121720] hover:bg-slate-800/80 active:bg-slate-800 border border-white/10 rounded-lg text-xs font-medium text-slate-200 inline-flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <svg className="w-3.5 h-3.5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  ></path>
                </svg>
                <span>{copied ? 'Copied!' : 'Copy Link'}</span>
              </button>
            </div>
          </section>
        </div>
      </main>

      {/* Fullscreen 3D Spatial Viewer Modal */}
      {show3DModal && (
        <Interactive3DModal project={project} onClose={() => setShow3DModal(false)} />
      )}
    </div>
  );
};
