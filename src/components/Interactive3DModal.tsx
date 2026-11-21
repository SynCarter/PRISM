import React, { useState } from 'react';
import { ProjectJob } from '../types';
import { SpzViewer } from './SpzViewer';

interface Interactive3DModalProps {
  project: ProjectJob;
  onClose: () => void;
}

export const Interactive3DModal: React.FC<Interactive3DModalProps> = ({ project, onClose }) => {
  // modelPath is the signed project-images URL. It ends in a query string, so
  // checking `endsWith('.spz')` would incorrectly discard a valid signed URL.
  const spzUrl = project.modelPath
    ? (project.modelPath.startsWith('http') || project.modelPath.startsWith('/') ? project.modelPath : `/${project.modelPath}`)
    : '/DemoModelling.spz';

  const [isFullscreen, setIsFullscreen] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-2 sm:p-6 animate-fade-in">
      <div className={`relative w-full ${isFullscreen ? 'h-full max-w-none' : 'max-w-7xl h-[88vh]'} rounded-2xl overflow-hidden border border-[#ea580c]/50 bg-[#060910] shadow-[0_0_90px_rgba(234,88,12,0.25)] flex flex-col transition-all duration-300`}>
        {/* Modal Top Header */}
        <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between bg-[#080d17]/90 backdrop-blur-md z-20">
          <div className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ea580c] animate-ping"></span>
            <div>
              <h2 className="text-white font-semibold text-sm sm:text-base tracking-wide flex items-center gap-2">
                <span>{project.name}</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-[#ea580c]/20 text-[#ea580c] font-mono border border-[#ea580c]/40 font-bold uppercase tracking-wider">
                  SPZ FLIGHT VIEWER
                </span>
              </h2>
              <span className="text-[11px] text-slate-400 font-mono">
                FORMAT: 3D Gaussian Splat (.spz) • WebGPU / WebGL2 Drone Camera
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-mono text-slate-300 hover:text-white transition-colors cursor-pointer hidden sm:flex items-center gap-1.5"
              title="Toggle Fullscreen"
            >
              <span className="material-symbols-outlined text-sm">
                {isFullscreen ? 'fullscreen_exit' : 'fullscreen'}
              </span>
              <span>{isFullscreen ? 'Collapse' : 'Expand'}</span>
            </button>

            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full border border-white/20 bg-white/5 hover:bg-white/15 text-slate-300 hover:text-white flex items-center justify-center transition-all cursor-pointer"
              title="Close 3D View"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Native PRISM viewer: no separately hosted iframe application. */}
        <div className="relative flex-1 w-full h-full bg-[#090b0e] overflow-hidden">
          <SpzViewer spzUrl={spzUrl} />
        </div>
      </div>
    </div>
  );
};
