import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ProjectJob } from '../types';
import { ReconstructionStepper } from './ReconstructionStepper';
import { Interactive3DModal } from './Interactive3DModal';
import { supabase } from '../lib/supabase';
import { getProjectSpzUrl, downloadSpzFile } from '../lib/spzDownloader';

export interface UploadProgress {
    uploaded: number;
    total: number;
}

interface ProcessingScreenProps {
    project?: ProjectJob | null;
    uploadProgress?: UploadProgress | null;
    uploadError?: string | null;
    onBackToProjects: () => void;
    onComplete?: (spzUrl?: string) => void;
    onUpdateStep?: (step: number) => void;
    onNavigateToUpload?: () => void;
    onNavigateToDetails?: () => void;
}

export interface ReconstructionStageDef {
    id: number;
    title: string;
    ongoingDesc: string;
    completedDesc: string;
}

export interface ReconstructionJobRow {
    job_id: string;
    project_id: string;
    status: string;
    stage: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    error_message?: string | null;
    error?: string | null;
    [key: string]: unknown;
}

export const RECONSTRUCTION_STAGES: ReconstructionStageDef[] = [
    {
        id: 1,
        title: "Image Ingestion",
        ongoingDesc: "Uploading and validating the photographic dataset to Supabase Storage.",
        completedDesc: "Photographic dataset validated and stored in Supabase Storage."
    },
    {
        id: 2,
        title: "Spatial Reconstruction",
        ongoingDesc: "COLMAP is performing feature extraction, feature matching, and camera pose estimation.",
        completedDesc: "Spatial reconstruction completed and scene geometry generated."
    },
    {
        id: 3,
        title: "Gaussian Splatting",
        ongoingDesc: "Generating the Gaussian Splat representation from the reconstructed scene.",
        completedDesc: "Gaussian Splat representation generated successfully."
    },
    {
        id: 4,
        title: "SPZ Generation",
        ongoingDesc: "Converting the Gaussian Splat representation into the SPZ format.",
        completedDesc: "SPZ model generated and stored in Supabase Storage."
    },
    {
        id: 5,
        title: "Model Preparation",
        ongoingDesc: "Preparing the reconstructed model for browser-based visualization.",
        completedDesc: "Reconstructed model is ready for interactive exploration."
    }
];

export const STAGE_NAME_TO_STEP: Record<string, number> = {
    'Image Ingestion': 1,
    'Spatial Reconstruction': 2,
    'Gaussian Splatting': 3,
    'SPZ Generation': 4,
    'Model Preparation': 5
};

/**
 * Maps reconstruction_jobs.stage and reconstruction_jobs.status to the active stepper stage.
 *
 * Rules:
 * - downloading or colmap → Stage 2 (Spatial Reconstruction) active
 * - training → Stage 3 (Gaussian Splatting) active
 * - exporting → Stage 4 (SPZ Generation) active
 * - done or status === 'completed' → Stage 5 (Model Preparation) completed
 * - status === 'failed' → show error state
 */
export function evaluateJobProgress(
    stage?: string | null,
    status?: string | null
): {
    step: number;
    isCompleted: boolean;
    isFailed: boolean;
} {
    const normStatus = (status || '').trim().toLowerCase();
    const normStage = (stage || '').trim().toLowerCase();

    // 1. Error state: status === 'failed'
    if (normStatus === 'failed') {
        let step = 1;
        if (normStage === 'downloading' || normStage === 'colmap' || normStage.includes('spatial')) {
            step = 2;
        } else if (normStage === 'training' || normStage.includes('gaussian') || normStage.includes('splat')) {
            step = 3;
        } else if (normStage === 'exporting' || normStage.includes('spz')) {
            step = 4;
        } else if (normStage === 'done' || normStage.includes('model') || normStage.includes('prep')) {
            step = 5;
        }
        return { step, isCompleted: false, isFailed: true };
    }

    // 2. Completed: done or status === 'completed'
    if (normStage === 'done' || normStatus === 'completed') {
        return { step: 5, isCompleted: true, isFailed: false };
    }

    // 3. Stage 4 active: exporting
    if (
        normStage === 'exporting' ||
        normStage === 'spz generation' ||
        normStage === 'spz_generation' ||
        normStage.includes('export')
    ) {
        return { step: 4, isCompleted: false, isFailed: false };
    }

    // 4. Stage 3 active: training
    if (
        normStage === 'training' ||
        normStage === 'gaussian splatting' ||
        normStage === 'gaussian_splatting' ||
        normStage.includes('train')
    ) {
        return { step: 3, isCompleted: false, isFailed: false };
    }

    // 5. Stage 2 active: downloading or colmap
    if (
        normStage === 'downloading' ||
        normStage === 'colmap' ||
        normStage === 'spatial reconstruction' ||
        normStage === 'spatial_reconstruction' ||
        normStage.includes('colmap') ||
        normStage.includes('download') ||
        normStage.includes('spatial')
    ) {
        return { step: 2, isCompleted: false, isFailed: false };
    }

    // 6. Stage 1 active: Image Ingestion
    return { step: 1, isCompleted: false, isFailed: false };
}

export function getStepFromStage(stageName?: string | null, status?: string | null): number {
    return evaluateJobProgress(stageName, status).step;
}

/**
 * Load .spz model path / signed URL from reconstructed_models table,
 * falling back to the project-images storage bucket.
 */
export async function loadSpzFromReconstructedModels(projectId: string): Promise<string | null> {
    if (!projectId || projectId === 'draft') return null;

    try {
        const { data: models, error: modelsError } = await supabase
            .from('reconstructed_models')
            .select('*')
            .eq('project_id', projectId)
            .order('created_at', { ascending: false });

        if (!modelsError && models && models.length > 0) {
            for (const row of models) {
                const candidate = [
                    row.storage_path,
                    row.file_path,
                    row.model_path,
                    row.spz_path,
                    row.path,
                    row.file_name,
                    row.model_url,
                    row.spz_url,
                    row.url
                ].find((val): val is string => typeof val === 'string' && val.length > 0);

                if (!candidate) continue;

                // Absolute HTTP/HTTPS URL
                if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
                    const bucketPrefix = 'project-images/';
                    const bucketIndex = candidate.indexOf(bucketPrefix);
                    if (bucketIndex !== -1) {
                        const pathPart = decodeURIComponent(candidate.slice(bucketIndex + bucketPrefix.length).split('?')[0]);
                        const { data: signed } = await supabase.storage
                            .from('project-images')
                            .createSignedUrl(pathPart, 60 * 60);
                        if (signed?.signedUrl) return signed.signedUrl;
                    }
                    return candidate;
                }

                // Storage path within project-images bucket
                let cleanPath = candidate.startsWith('project-images/')
                    ? candidate.slice('project-images/'.length)
                    : candidate;
                if (cleanPath.startsWith('/')) cleanPath = cleanPath.slice(1);

                const { data: signedFile, error: signedUrlError } = await supabase.storage
                    .from('project-images')
                    .createSignedUrl(cleanPath, 60 * 60);

                if (!signedUrlError && signedFile?.signedUrl) {
                    return signedFile.signedUrl;
                }

                const { data: pubData } = supabase.storage
                    .from('project-images')
                    .getPublicUrl(cleanPath);

                if (pubData?.publicUrl) {
                    return pubData.publicUrl;
                }
            }
        }
    } catch (err) {
        console.warn('Error querying reconstructed_models:', err);
    }

    // Direct storage fallback: scan project-images/{projectId}/ for *.spz
    try {
        const { data: files, error: listError } = await supabase.storage
            .from('project-images')
            .list(projectId, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });

        if (!listError && files) {
            const modelFile = files.find((f) => f.name.toLowerCase().endsWith('.spz'));
            if (modelFile) {
                const { data: signedFile } = await supabase.storage
                    .from('project-images')
                    .createSignedUrl(`${projectId}/${modelFile.name}`, 60 * 60);

                if (signedFile?.signedUrl) {
                    return signedFile.signedUrl;
                }
            }
        }
    } catch (err) {
        console.warn('Error checking storage bucket for SPZ:', err);
    }

    return null;
}

export const ProcessingScreen: React.FC<ProcessingScreenProps> = ({
    project,
    uploadProgress,
    uploadError,
    onBackToProjects,
    onComplete,
    onUpdateStep
}) => {
    const [job, setJob] = useState<ReconstructionJobRow | null>(null);
    const [loadedModelUrl, setLoadedModelUrl] = useState<string | null>(null);
    const [isFailedState, setIsFailedState] = useState<boolean>(false);
    const [isCompletedOverride, setIsCompletedOverride] = useState<boolean>(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(uploadError || null);
    const [show3DModal, setShow3DModal] = useState<boolean>(false);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
    const [copied, setCopied] = useState<boolean>(false);
    const [isDownloadingSpz, setIsDownloadingSpz] = useState<boolean>(false);

    const onCompleteRef = useRef(onComplete);
    onCompleteRef.current = onComplete;
    const onUpdateStepRef = useRef(onUpdateStep);
    onUpdateStepRef.current = onUpdateStep;

    const effectiveUploadProgress: UploadProgress | null = uploadProgress
        ? uploadProgress
        : (project?.photographsCount && project.photographsCount > 0
            ? { uploaded: project.photographsCount, total: project.photographsCount }
            : null);

    const progress = evaluateJobProgress(job?.stage, job?.status);

    const isFailed = isFailedState || progress.isFailed || Boolean(uploadError) || project?.status === 'failed';
    const isCompleted = !isFailed && (isCompletedOverride || progress.isCompleted || project?.status === 'completed');

    const isUploadFinished = Boolean(
        effectiveUploadProgress &&
        effectiveUploadProgress.total > 0 &&
        effectiveUploadProgress.uploaded >= effectiveUploadProgress.total
    );

    const currentStep = isCompleted
        ? 5
        : job?.stage
            ? progress.step
            : (isUploadFinished ? Math.max(2, project?.currentStep || 2) : (project?.currentStep || 1));

    const activeStage = RECONSTRUCTION_STAGES[currentStep - 1] || RECONSTRUCTION_STAGES[0];

    const finalModelUrl = loadedModelUrl || (
        project?.modelPath
            ? (project.modelPath.startsWith('http') || project.modelPath.startsWith('/') ? project.modelPath : `/${project.modelPath}`)
            : '/DemoModelling.spz'
    );

    // Process job updates from polling or Supabase Realtime
    const handleJobUpdate = useCallback(async (jobRow: ReconstructionJobRow) => {
        setJob(jobRow);

        const evalResult = evaluateJobProgress(jobRow.stage, jobRow.status);

        if (evalResult.isFailed) {
            setIsFailedState(true);
            const err = jobRow.error_message ||
                ((jobRow as Record<string, unknown>).error as string) ||
                uploadError ||
                'Reconstruction job failed.';
            setErrorMessage(err);
            return;
        }

        setIsFailedState(false);
        onUpdateStepRef.current?.(evalResult.step);

        if (evalResult.isCompleted) {
            setIsCompletedOverride(true);
            const spzUrl = await loadSpzFromReconstructedModels(jobRow.project_id);
            if (spzUrl) {
                setLoadedModelUrl(spzUrl);
            }
            onCompleteRef.current?.(spzUrl || undefined);
        }
    }, [uploadError]);

    // Live update reconstruction progress: Supabase Realtime + 3-second polling fallback
    useEffect(() => {
        const projectId = project?.id;
        if (!projectId || projectId === 'draft') return;

        let isMounted = true;

        const fetchJob = async () => {
            try {
                const { data, error } = await supabase
                    .from('reconstruction_jobs')
                    .select('*')
                    .eq('project_id', projectId)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (error) {
                    console.warn('Error querying reconstruction_jobs:', error.message);
                    return;
                }

                if (data && isMounted) {
                    await handleJobUpdate(data as ReconstructionJobRow);
                }
            } catch (err) {
                console.warn('Failed to fetch reconstruction_jobs:', err);
            }
        };

        // Fetch immediately on mount
        fetchJob();

        // 1. Supabase Realtime subscription
        const channel = supabase
            .channel(`reconstruction_jobs_live_${projectId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'reconstruction_jobs',
                    filter: `project_id=eq.${projectId}`
                },
                (payload) => {
                    if (!isMounted) return;
                    if (payload.new && typeof payload.new === 'object') {
                        handleJobUpdate(payload.new as ReconstructionJobRow);
                    }
                }
            )
            .subscribe();

        // 2. Poll every 3 seconds
        const interval = setInterval(() => {
            if (!isCompleted) {
                fetchJob();
            }
        }, 3000);

        return () => {
            isMounted = false;
            clearInterval(interval);
            supabase.removeChannel(channel);
        };
    }, [project?.id, isCompleted, handleJobUpdate]);

    // Ensure model is loaded whenever completed state is reached
    useEffect(() => {
        const projectId = project?.id;
        if (!projectId || projectId === 'draft') return;

        if (isCompleted && !loadedModelUrl) {
            loadSpzFromReconstructedModels(projectId).then((url) => {
                if (url) {
                    setLoadedModelUrl(url);
                    onCompleteRef.current?.(url);
                }
            });
        }
    }, [isCompleted, project?.id, loadedModelUrl]);

    // Sync uploadError changes
    useEffect(() => {
        if (uploadError) {
            setIsFailedState(true);
            setErrorMessage(uploadError);
        }
    }, [uploadError]);

    const handleMouseMove = (e: React.MouseEvent<HTMLElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setMousePos({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        });
    };

    const handleCopyLink = () => {
        const shareUrl = project?.shareUrl || (project?.id ? `https://prism.app/share/${project.id}` : 'https://prism.app');
        navigator.clipboard.writeText(shareUrl).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const handleDownloadSpz = async () => {
        setIsDownloadingSpz(true);
        try {
            const url = await getProjectSpzUrl(project?.id || '', finalModelUrl);
            if (url) {
                await downloadSpzFile(url, `${project?.name || 'reconstruction'}.spz`);
            } else {
                alert(`No .spz model was found in Supabase for "${project?.name || 'reconstruction'}".`);
            }
        } catch (err: unknown) {
            console.error('Failed to download SPZ:', err);
            const msg = err instanceof Error ? err.message : 'Download failed';
            alert(`Could not download SPZ: ${msg}`);
        } finally {
            setIsDownloadingSpz(false);
        }
    };

    return (
        <div className="min-h-screen bg-[#06080c] text-slate-100 flex flex-col justify-start pb-20 font-sans antialiased">
            {/* Functional Reconstruction Stepper */}
            <ReconstructionStepper
                currentStage={3}
                isProcessingFinished={isCompleted}
                onBackToProjects={onBackToProjects}
            />

            <main className="w-full max-w-[1240px] mx-auto px-6 sm:px-8 pt-8 flex-1 flex flex-col justify-start animate-page-enter">
                {/* Page Title & Description Header */}
                <div className="mb-9 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <h1 className="text-[32px] sm:text-[34px] font-semibold text-white tracking-[-0.015em] leading-tight mb-2">
                            {project?.name || 'Reconstruction Project'}
                        </h1>
                        <p className="text-[#8494a8] text-[14.5px] font-normal leading-relaxed">
                            {project?.description || "Multi-angle photogrammetry capture for 3D Gaussian Splat reconstruction."}
                        </p>
                    </div>
                </div>

                {/* Main Reconstruction Status Card Container */}
                <section className="bg-[#0b1017] border border-[#141c26] rounded-2xl p-8 sm:p-10 lg:p-12 mb-6 shadow-2xl relative">
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-14 items-center">
                        {/* Left Stepper Column: 5-stage tracker */}
                        <div className="lg:col-span-6 flex flex-col">
                            {RECONSTRUCTION_STAGES.map((stage, idx) => {
                                const stepNum = stage.id;
                                const isStepCompleted = isCompleted || (!isFailed && stepNum < currentStep) || (isFailed && stepNum < currentStep);
                                const isStepActive = !isCompleted && !isFailed && stepNum === currentStep;
                                const isStepFailed = isFailed && stepNum === currentStep;
                                const isLast = idx === RECONSTRUCTION_STAGES.length - 1;

                                return (
                                    <div key={stage.id} className="flex items-start gap-5 relative">
                                        <div className="flex flex-col items-center self-stretch">
                                            {isStepCompleted ? (
                                                <div className="w-8 h-8 rounded-full bg-[#ea580c] flex items-center justify-center shadow-[0_0_15px_rgba(234,88,12,0.35)] shrink-0 z-10 transition-all duration-300">
                                                    <svg className="w-4 h-4 text-[#0b1017] stroke-[2.8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"></path>
                                                    </svg>
                                                </div>
                                            ) : isStepFailed ? (
                                                <div className="w-8 h-8 rounded-full border-2 border-rose-500 bg-[#160b0e] text-rose-500 flex items-center justify-center shrink-0 z-10 shadow-[0_0_18px_rgba(244,63,94,0.4)] transition-all duration-300">
                                                    <svg className="w-4 h-4 stroke-[2.8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round"></path>
                                                    </svg>
                                                </div>
                                            ) : isStepActive ? (
                                                <div className="w-8 h-8 rounded-full border-2 border-[#ea580c] bg-[#0b1017] flex items-center justify-center shrink-0 z-10 shadow-[0_0_18px_rgba(234,88,12,0.4)] transition-all duration-300">
                                                    <div className="w-3.5 h-3.5 rounded-full bg-[#ea580c] animate-pulse"></div>
                                                </div>
                                            ) : (
                                                <div className="w-8 h-8 rounded-full border-2 border-[#242e3e] bg-[#0b1017] shrink-0 z-10 transition-all duration-300"></div>
                                            )}

                                            {!isLast && (
                                                <div
                                                    className={`w-[2px] flex-1 min-h-[34px] my-1 transition-all duration-500 ${
                                                        isStepCompleted
                                                            ? 'bg-[#ea580c]'
                                                            : isStepActive
                                                            ? 'stepper-dashed-line'
                                                            : isStepFailed
                                                            ? 'bg-rose-500/40'
                                                            : 'bg-[#1a2330]'
                                                    }`}
                                                ></div>
                                            )}
                                        </div>

                                        <div className="pt-0.5 pb-5">
                                            <div className="flex items-center gap-2.5 mb-1.5">
                                                <h3
                                                    className={`text-[15.5px] font-medium leading-none tracking-tight transition-colors duration-300 ${
                                                        isStepFailed
                                                            ? 'text-rose-300'
                                                            : isStepActive || isStepCompleted
                                                            ? 'text-white'
                                                            : 'text-slate-400'
                                                    }`}
                                                >
                                                    {stage.title}
                                                </h3>
                                                {isStepActive && (
                                                    <span className="font-mono text-[9px] uppercase tracking-wider text-[#ea580c] bg-[#ea580c]/15 border border-[#ea580c]/30 px-2 py-0.5 rounded-full">
                                                        In Progress
                                                    </span>
                                                )}
                                                {isStepCompleted && (
                                                    <span className="font-mono text-[9px] uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 rounded-full">
                                                        Completed
                                                    </span>
                                                )}
                                                {isStepFailed && (
                                                    <span className="font-mono text-[9px] uppercase tracking-wider text-rose-400 bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 rounded-full">
                                                        Failed
                                                    </span>
                                                )}
                                            </div>
                                            <p
                                                className={`text-[13px] font-normal leading-normal transition-colors duration-300 ${
                                                    isStepFailed
                                                        ? 'text-rose-300/80'
                                                        : isStepCompleted
                                                        ? 'text-[#718197]'
                                                        : isStepActive
                                                        ? 'text-slate-200'
                                                        : 'text-[#4e5c70]'
                                                }`}
                                            >
                                                {isStepFailed
                                                    ? (errorMessage || "An error occurred during this stage.")
                                                    : isStepCompleted
                                                    ? stage.completedDesc
                                                    : stage.ongoingDesc}
                                            </p>

                                            {/* Live Upload Counter for Stage 1 (Image Ingestion) */}
                                            {stage.id === 1 && effectiveUploadProgress && effectiveUploadProgress.total > 0 && !isCompleted && (
                                                <div className="mt-2.5 flex items-center gap-1.5 font-mono text-[12.5px] text-slate-300">
                                                    <span className="text-[#ea580c] font-semibold">{effectiveUploadProgress.uploaded}</span>
                                                    <span className="text-slate-500">/</span>
                                                    <span className="text-slate-300">{effectiveUploadProgress.total}</span>
                                                    <span className="text-slate-400 font-sans text-[12px] ml-1">uploaded</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Right Status Panel */}
                        <div className="lg:col-span-6 flex items-center justify-center lg:border-l lg:border-[#151c27] lg:pl-10 xl:pl-12 py-2">
                            <div className="w-full bg-[#080c12]/95 border border-[#141b25] rounded-2xl p-8 sm:p-9 shadow-inner">
                                {!isCompleted ? (
                                    /* Processing / Failed State */
                                    <div>
                                        {/* Status Row */}
                                        <div className="flex items-center gap-4 mb-4">
                                            {isFailed ? (
                                                <div className="w-9 h-9 rounded-full bg-rose-500/15 border border-rose-500/40 flex items-center justify-center text-rose-400 shadow-[0_0_15px_rgba(244,63,94,0.3)] shrink-0">
                                                    <svg className="w-5 h-5 stroke-[2.5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 7.5h.008v.008H12v-.008z" strokeLinecap="round" strokeLinejoin="round"></path>
                                                    </svg>
                                                </div>
                                            ) : (
                                                <div className="relative w-9 h-9 shrink-0 flex items-center justify-center">
                                                    <svg className="animate-spin w-9 h-9" fill="none" viewBox="0 0 40 40">
                                                        <circle cx="20" cy="20" r="16" stroke="#251a14" strokeLinecap="round" strokeWidth="3"></circle>
                                                        <path
                                                            d="M20 4 C28.8366 4 36 11.1634 36 20 C36 24.5 34.2 28.5 31.2 31.5"
                                                            stroke="#ea580c"
                                                            strokeLinecap="round"
                                                            strokeWidth="3.2"
                                                        ></path>
                                                    </svg>
                                                </div>
                                            )}

                                            <div>
                                                <span className={`font-semibold text-[13px] tracking-[0.14em] uppercase select-none block ${isFailed ? 'text-rose-400' : 'text-[#ea580c]'}`}>
                                                    {isFailed
                                                        ? 'Reconstruction Failed'
                                                        : (job?.status?.toLowerCase() === 'pending' && currentStep === 1)
                                                            ? 'Reconstruction Pending'
                                                            : 'Reconstruction in progress'}
                                                </span>
                                                <span className="text-slate-400 text-xs font-mono">
                                                    {isFailed
                                                        ? `Failed at Stage ${currentStep} • ${activeStage.title}`
                                                        : `Stage ${currentStep} of 5 • ${activeStage.title}`}
                                                </span>
                                            </div>
                                        </div>

                                        <p className="text-[#7b8a9e] text-[13.5px] leading-relaxed font-normal min-h-[44px]">
                                            {isFailed
                                                ? (errorMessage || "The reconstruction process encountered an error and could not complete.")
                                                : activeStage.ongoingDesc}
                                        </p>

                                        {/* Metadata Info Rows */}
                                        <div className="mt-5 pt-4 border-t border-white/5 space-y-2.5 text-xs font-mono text-slate-400">
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-500">Current Stage</span>
                                                <span className={isFailed ? 'text-rose-400 font-medium' : 'text-[#ea580c] font-medium'}>
                                                    {activeStage.title}
                                                </span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-500">Status</span>
                                                <span className={`capitalize font-medium ${isFailed ? 'text-rose-400 font-semibold' : 'text-slate-200'}`}>
                                                    {isFailed
                                                        ? 'Failed'
                                                        : (job?.status?.toLowerCase() === 'pending' && currentStep === 1)
                                                            ? 'Pending'
                                                            : 'Running'}
                                                </span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-500">Model Format</span>
                                                <span className="text-slate-200 font-medium">3D Gaussian Splat (.spz)</span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-500">Model Size</span>
                                                <span className="text-slate-400 italic">
                                                    {isFailed ? 'Unavailable' : 'Calculating...'}
                                                </span>
                                            </div>
                                        </div>

                                        {isFailed && (
                                            <div className="mt-5 p-4 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-300 text-xs space-y-1.5">
                                                <div className="flex items-center gap-2 font-semibold text-rose-200">
                                                    <span className="material-symbols-outlined text-sm text-rose-400">error</span>
                                                    <span>Error State Details</span>
                                                </div>
                                                <p className="font-mono text-[11.5px] leading-relaxed break-words text-rose-300/90">
                                                    {errorMessage || 'The reconstruction job encountered a failure. Please check logs or re-upload your images.'}
                                                </p>
                                                <div className="pt-2">
                                                    <button
                                                        type="button"
                                                        onClick={onBackToProjects}
                                                        className="px-3.5 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/40 text-xs font-mono transition-colors cursor-pointer"
                                                    >
                                                        ← Back to Projects
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    /* Completed State: Model preparation completed & .spz loaded */
                                    <div>
                                        {/* Status Header */}
                                        <div className="flex items-center gap-3.5 mb-3.5">
                                            <div className="w-9 h-9 rounded-full bg-[#ea580c]/15 border border-[#ea580c]/40 flex items-center justify-center text-[#ea580c] shadow-[0_0_15px_rgba(234,88,12,0.25)] shrink-0">
                                                <svg className="w-5 h-5 stroke-[2.8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"></path>
                                                </svg>
                                            </div>
                                            <div>
                                                <span className="text-emerald-400 font-semibold text-[13.5px] tracking-[0.14em] uppercase select-none block">
                                                    Reconstruction Completed
                                                </span>
                                                <span className="text-slate-400 text-xs font-mono">
                                                    Stage 5 of 5 • Model Preparation Complete
                                                </span>
                                            </div>
                                        </div>

                                        <p className="text-[#7b8a9e] text-[13px] leading-relaxed font-normal mb-4">
                                            Reconstructed 3D Gaussian Splat model (.spz) is loaded from reconstructed_models and ready for interactive exploration.
                                        </p>

                                        {/* Action buttons: View 3D Model & Download SPZ */}
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
                                            <button
                                                type="button"
                                                onClick={() => setShow3DModal(true)}
                                                className="w-full inline-flex items-center justify-center gap-2.5 px-5 py-3 rounded-xl bg-[#ea580c] hover:bg-[#f97316] text-black text-xs font-bold uppercase tracking-wider transition-all shadow-[0_0_25px_rgba(234,88,12,0.4)] cursor-pointer text-center"
                                            >
                                                <span className="material-symbols-outlined text-base">flight</span>
                                                <span>View 3D Model</span>
                                            </button>

                                            <button
                                                type="button"
                                                disabled={isDownloadingSpz}
                                                onClick={handleDownloadSpz}
                                                className="w-full inline-flex items-center justify-center gap-2.5 px-5 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/15 text-slate-200 hover:text-white text-xs font-mono uppercase tracking-wider transition-colors cursor-pointer text-center disabled:opacity-50"
                                            >
                                                {isDownloadingSpz ? (
                                                    <>
                                                        <div className="w-3.5 h-3.5 rounded-full border-2 border-[#ea580c]/30 border-t-[#ea580c] animate-spin"></div>
                                                        <span>Downloading...</span>
                                                    </>
                                                ) : (
                                                    <>
                                                        <span className="material-symbols-outlined text-base text-[#ea580c]">download</span>
                                                        <span>Download SPZ</span>
                                                    </>
                                                )}
                                            </button>
                                        </div>

                                        {/* Model Preview Card */}
                                        <button
                                            type="button"
                                            onClick={() => setShow3DModal(true)}
                                            onMouseMove={handleMouseMove}
                                            className="block w-full overflow-hidden rounded-xl bg-[#07090e] relative aspect-[16/10] min-h-[220px] sm:min-h-[240px] border border-[#ea580c]/30 hover:border-[#ea580c] group cursor-pointer select-none mb-4 transition-all shadow-[0_10px_35px_rgba(0,0,0,0.8)]"
                                            title="Click to launch interactive 3D model viewer"
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
                                                    WebkitMaskImage: `radial-gradient(240px 240px at ${mousePos.x}px ${mousePos.y}px, black 20%, transparent 80%)`,
                                                    maskImage: `radial-gradient(240px 240px at ${mousePos.x}px ${mousePos.y}px, black 20%, transparent 80%)`
                                                }}
                                            ></div>

                                            {/* Radial glow */}
                                            <div
                                                className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                                                style={{
                                                    background: `radial-gradient(380px circle at ${mousePos.x}px ${mousePos.y}px, rgba(249, 150, 57, 0.16), rgba(255, 122, 41, 0.05) 50%, transparent 80%)`
                                                }}
                                            ></div>

                                            <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_80px_rgba(0,0,0,0.8)]"></div>

                                            {/* Centered Content */}
                                            <div className="relative z-10 w-full h-full flex flex-col items-center justify-center gap-3.5 backdrop-blur-[1px] p-6 text-center">
                                                <div className="w-14 h-14 rounded-full bg-[#161c26]/90 border border-white/10 flex items-center justify-center text-[#ea580c] group-hover:scale-110 group-hover:border-[#ea580c]/60 group-hover:shadow-[0_0_30px_rgba(234,88,12,0.5)] transition-all">
                                                    <span className="material-symbols-outlined text-2xl">flight</span>
                                                </div>
                                                <div>
                                                    <div className="flex items-center justify-center gap-2 text-sm sm:text-base font-semibold text-slate-100 group-hover:text-white transition-colors">
                                                        <span>Launch 3D Flight Viewer</span>
                                                        <span className="text-[#ea580c] transition-transform group-hover:translate-x-1.5 text-lg">→</span>
                                                    </div>
                                                    <p className="text-slate-400 text-xs font-mono mt-1">
                                                        Full-screen drone navigation • WASD + QE flight controls
                                                    </p>
                                                </div>
                                            </div>
                                        </button>

                                        {/* Metadata Info Rows: Model Format & Model Size */}
                                        <div className="pt-3.5 border-t border-white/10 space-y-2.5 text-xs font-mono text-slate-400">
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-500">Model Format</span>
                                                <span className="text-slate-200 font-medium">3D Gaussian Splat (.spz)</span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-500">Model Source</span>
                                                <span className="text-emerald-400 font-medium truncate max-w-[280px]">
                                                    {loadedModelUrl ? 'Loaded from reconstructed_models' : 'Project Model'}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </section>

                {/* Bottom Banner */}
                <aside className="bg-[#0b1017] border border-[#141c26] rounded-xl px-7 py-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-5">
                    <div className="flex items-center gap-4 max-w-3xl">
                        <div className="w-10 h-10 rounded-full border border-[#232d3c] flex items-center justify-center text-slate-300 shrink-0">
                            {isFailed ? (
                                <svg className="w-4 h-4 text-rose-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                                    <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round"></path>
                                </svg>
                            ) : !isCompleted ? (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                    <line x1="12" x2="12" y1="16" y2="12"></line>
                                    <line x1="12" x2="12.01" y1="8" y2="8"></line>
                                </svg>
                            ) : (
                                <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"></path>
                                </svg>
                            )}
                        </div>
                        <div className="space-y-0.5">
                            <h4 className="text-white text-[14px] font-medium tracking-tight">
                                {isFailed
                                    ? "Reconstruction failed."
                                    : !isCompleted
                                    ? "You can leave this page."
                                    : "Reconstruction is complete."}
                            </h4>
                            <p className="text-[#728296] text-[12.5px] leading-normal font-normal">
                                {isFailed
                                    ? "An error was encountered during the reconstruction pipeline. You can review the details or return to projects."
                                    : !isCompleted
                                    ? "The reconstruction will continue to run in the background. You can return to your projects at any time to check the status."
                                    : "Your 3D spatial model is ready. You can explore the digital twin at any time from your workspace."}
                            </p>
                        </div>
                    </div>

                    <div className="shrink-0 w-full md:w-auto flex items-center gap-3 justify-end">
                        {isCompleted && (
                            <button
                                type="button"
                                onClick={handleCopyLink}
                                className="w-full md:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-white/10 hover:border-white/20 bg-[#0c1118] text-[13px] font-medium text-slate-200 transition duration-150 cursor-pointer"
                            >
                                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path
                                        d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="1.8"
                                    ></path>
                                </svg>
                                <span>{copied ? 'Copied Link!' : 'Share Link'}</span>
                            </button>
                        )}

                        <button
                            onClick={onBackToProjects}
                            className="w-full md:w-auto inline-flex items-center justify-center gap-2.5 px-5 py-2.5 rounded-lg border border-[#202937] hover:border-[#2d3a4d] bg-[#0c1118] hover:bg-[#111722] text-[13px] font-medium text-slate-200 transition duration-150 ease-in-out shadow-sm cursor-pointer"
                        >
                            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path d="M10 19l-7-7m0 0l7-7m-7 7h18" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                            </svg>
                            <span>Back to Projects</span>
                        </button>
                    </div>
                </aside>
            </main>

            {/* Fullscreen 3D Spatial Viewer Modal */}
            {show3DModal && project && (
                <Interactive3DModal
                    project={{
                        ...project,
                        modelPath: finalModelUrl
                    }}
                    onClose={() => setShow3DModal(false)}
                />
            )}
        </div>
    );
};
