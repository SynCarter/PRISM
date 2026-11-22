import { useState, useEffect, useCallback } from 'react';
import { ViewMode, ProjectJob, JobStatus } from './types';
import { INITIAL_PROJECT_PHOTOS } from './data/mockProjects';
import { supabase } from './lib/supabase';
import { SpatialTour } from './components/SpatialTour';
import { ProjectsDashboard } from './components/ProjectsDashboard';
import { CreateProject } from './components/CreateProject';
import { UploadPhotographs } from './components/UploadPhotographs';
import { ProcessingScreen } from './components/ProcessingScreen';
import { ProjectDetail } from './components/ProjectDetail';
import { SpzViewer } from './components/SpzViewer';

interface SupabaseProjectRow {
    project_id: string;
    session_id: string | null;
    name: string;
    status: string;
    created_at: string;
}

type ReconstructedModelRow = Record<string, unknown> & {
    project_id?: string;
    created_at?: string;
};

/**
 * `reconstructed_models` has existed with a few storage-path column names.
 * Normalize the value to a path relative to the `project-images` bucket so a
 * short-lived signed URL can always be created for the embedded viewer.
 */
function getReconstructedModelPath(model: ReconstructedModelRow): string | null {
    const value = [
        model.storage_path,
        model.file_path,
        model.model_path,
        model.spz_path,
        model.path,
        model.file_name,
        model.model_url,
        model.spz_url,
        model.url
    ].find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

    if (!value) return null;

    const bucketPrefix = 'project-images/';
    let normalized = value;
    if (value.startsWith('http://') || value.startsWith('https://')) {
        try {
            const pathname = new URL(value).pathname;
            const bucketIndex = pathname.indexOf(bucketPrefix);
            if (bucketIndex !== -1) {
                normalized = decodeURIComponent(pathname.slice(bucketIndex + bucketPrefix.length));
            } else {
                return value.toLowerCase().includes('.spz') ? value : null;
            }
        } catch {
            return null;
        }
    } else if (value.startsWith(bucketPrefix)) {
        normalized = value.slice(bucketPrefix.length);
    }
    return normalized.toLowerCase().includes('.spz') ? normalized : null;
}

const MAX_UPLOAD_IMAGE_DIMENSION = 2048;
const UPLOAD_IMAGE_QUALITY = 0.92;

/**
 * Browser equivalent of the reconstruction worker's Pillow preprocessing:
 * honor EXIF orientation while decoding, downscale only oversized images, and
 * encode the resized image at high quality before it reaches Storage.
 */
async function resizeImageForUpload(source: Blob): Promise<Blob> {
    if (!source.type.startsWith('image/')) return source;

    const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
    try {
        const longestSide = Math.max(bitmap.width, bitmap.height);
        if (longestSide <= MAX_UPLOAD_IMAGE_DIMENSION) return source;

        const scale = MAX_UPLOAD_IMAGE_DIMENSION / longestSide;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const context = canvas.getContext('2d', { alpha: source.type === 'image/png' });
        if (!context) throw new Error('Unable to create an image resize context.');

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

        const outputType = source.type === 'image/png' ? 'image/png' : 'image/jpeg';
        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
                (blob) => blob ? resolve(blob) : reject(new Error('Unable to encode resized image.')),
                outputType,
                UPLOAD_IMAGE_QUALITY
            );
        });
    } finally {
        bitmap.close();
    }
}

function formatProjectDate(isoString: string): string {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    const day = date.getDate();
    const month = date.toLocaleString('default', { month: 'short' });
    const year = date.getFullYear();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${day} ${month} ${year}, ${time}`;
}

function mapSupabaseRowToJob(row: SupabaseProjectRow): ProjectJob {
    const normalizedStatus = (
        row.status === 'completed' ||
            row.status === 'processing' ||
            row.status === 'pending' ||
            row.status === 'failed'
            ? row.status
            : 'pending'
    ) as JobStatus;

    return {
        id: row.project_id,
        name: row.name || 'Untitled Project',
        description: '',
        dateCreated: formatProjectDate(row.created_at),
        photographsCount: 0,
        status: normalizedStatus,
        currentStep: normalizedStatus === 'completed' ? 5 : 1,
        thumbnailUrl: '',
        modelFormat: '3D Gaussian Splat (.spz)',
        modelPath: '',
        shareUrl: '',
        photos: []
    };
}

const isDemoOnlyEnv = import.meta.env.VITE_DEMO_ONLY === 'true';

function checkIsDemoRoute(): boolean {
    if (isDemoOnlyEnv) return true;
    if (typeof window === 'undefined') return false;
    const path = window.location.pathname.toLowerCase();
    const params = new URLSearchParams(window.location.search);
    return path === '/demo' || path.startsWith('/demo/') || params.get('demo') === 'true';
}

export default function App() {
    const [isDemo, setIsDemo] = useState<boolean>(checkIsDemoRoute);
    const [view, setView] = useState<ViewMode>('tour');
    const [projects, setProjects] = useState<ProjectJob[]>([]);
    const [isLoadingProjects, setIsLoadingProjects] = useState<boolean>(true);
    const [projectsError, setProjectsError] = useState<string | null>(null);
    const [activeProjectId, setActiveProjectId] = useState<string>('');
    const [draftProject, setDraftProject] = useState<{
        name: string;
        description: string;
        photos: string[];
        fileMap?: Map<string, File>;
    } | null>(null);
    const [committedDraftProjectId, setCommittedDraftProjectId] = useState<string | null>(null);
    const [transitionState, setTransitionState] = useState<'idle' | 'exiting-projects' | 'exiting-create'>('idle');

    const [isCreatingProject, setIsCreatingProject] = useState<boolean>(false);
    const [createProjectError, setCreateProjectError] = useState<string | null>(null);
    const [uploadProgress, setUploadProgress] = useState<{ uploaded: number; total: number } | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);

    // Ensures an active Supabase anonymous session and corresponding row in public.sessions
    const ensureSession = async (): Promise<string> => {
        let uid: string | undefined;

        const { data: sessionData } = await supabase.auth.getSession();
        if (sessionData?.session?.user?.id) {
            uid = sessionData.session.user.id;
        } else {
            const { data: authData, error: authError } = await supabase.auth.signInAnonymously();
            if (authError || !authData?.user?.id) {
                throw new Error(authError?.message || 'Failed to initialize anonymous session.');
            }
            uid = authData.user.id;
        }

        // Verify or insert session row in public.sessions
        const { data: existingSessions, error: checkError } = await supabase
            .from('sessions')
            .select('session_id')
            .eq('session_id', uid)
            .limit(1);

        if (checkError) {
            throw new Error(`Session verification failed: ${checkError.message}`);
        }

        if (!existingSessions || existingSessions.length === 0) {
            const { error: insertSessionError } = await supabase
                .from('sessions')
                .insert({ session_id: uid });

            if (insertSessionError && insertSessionError.code !== '23505') {
                throw new Error(`Failed to create session: ${insertSessionError.message}`);
            }
        }

        return uid;
    };

    const fetchProjects = useCallback(async () => {
        setIsLoadingProjects(true);
        setProjectsError(null);
        try {
            const { data, error } = await supabase
                .from('projects')
                .select('project_id, session_id, name, status, created_at')
                .order('created_at', { ascending: false });

            if (error) {
                throw new Error(error.message);
            }

            const rawProjects = data || [];
            const projectIds = rawProjects.map((p) => p.project_id);

            // Fetch uploaded images for these projects to get actual photos and thumbnails
            // Fetch uploaded images for these projects from storage & metadata to get random thumbnails
            const imagePathsByProject = new Map<string, string[]>();
            const randomThumbnailByProject = new Map<string, string>();
            const spzUrlByProject = new Map<string, string>();

            if (projectIds.length > 0) {
                // 1. Collect image paths from uploaded_images metadata table
                try {
                    const { data: imagesData } = await supabase
                        .from('uploaded_images')
                        .select('project_id, file_path, uploaded_at')
                        .in('project_id', projectIds)
                        .order('uploaded_at', { ascending: true });

                    if (imagesData) {
                        for (const img of imagesData) {
                            const rawPath = img.file_path || '';
                            const cleanPath = rawPath.startsWith('project-images/')
                                ? rawPath.slice('project-images/'.length)
                                : rawPath;

                            if (cleanPath) {
                                const list = imagePathsByProject.get(img.project_id) || [];
                                if (!list.includes(cleanPath)) {
                                    list.push(cleanPath);
                                }
                                imagePathsByProject.set(img.project_id, list);
                            }
                        }
                    }
                } catch (imgFetchErr) {
                    console.warn('Could not query uploaded_images table:', imgFetchErr);
                }

                // 2. Scan each project's storage bucket folder directly for all image assets & SPZ models
                await Promise.all(
                    projectIds.map(async (projectId) => {
                        try {
                            const { data: files, error: listError } = await supabase.storage
                                .from('project-images')
                                .list(projectId, { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });

                            if (!listError && files) {
                                const currentPaths = imagePathsByProject.get(projectId) || [];
                                for (const file of files) {
                                    if (/\.(jpe?g|png|webp|avif|bmp|tiff)$/i.test(file.name)) {
                                        const storagePath = `${projectId}/${file.name}`;
                                        if (!currentPaths.includes(storagePath)) {
                                            currentPaths.push(storagePath);
                                        }
                                    } else if (file.name.toLowerCase().endsWith('.spz') && !spzUrlByProject.has(projectId)) {
                                        const { data: signedSpz } = await supabase.storage
                                            .from('project-images')
                                            .createSignedUrl(`${projectId}/${file.name}`, 60 * 60);
                                        if (signedSpz?.signedUrl) {
                                            spzUrlByProject.set(projectId, signedSpz.signedUrl);
                                        }
                                    }
                                }
                                imagePathsByProject.set(projectId, currentPaths);
                            }
                        } catch (storageLookupError) {
                            console.warn(`Could not list storage for project ${projectId}:`, storageLookupError);
                        }
                    })
                );

                // 3. For each project, pick a random image from that project's bucket and sign it
                await Promise.all(
                    projectIds.map(async (projectId) => {
                        const paths = imagePathsByProject.get(projectId) || [];
                        if (paths.length > 0) {
                            const randomIndex = Math.floor(Math.random() * paths.length);
                            const randomImagePath = paths[randomIndex];

                            try {
                                const { data: signedImg, error: signErr } = await supabase.storage
                                    .from('project-images')
                                    .createSignedUrl(randomImagePath, 60 * 60);

                                if (!signErr && signedImg?.signedUrl) {
                                    randomThumbnailByProject.set(projectId, signedImg.signedUrl);
                                } else {
                                    const pubUrl = supabase.storage
                                        .from('project-images')
                                        .getPublicUrl(randomImagePath).data.publicUrl;
                                    if (pubUrl) {
                                        randomThumbnailByProject.set(projectId, pubUrl);
                                    }
                                }
                            } catch (signCatchErr) {
                                console.warn(`Could not sign random thumbnail for ${projectId}:`, signCatchErr);
                            }
                        }
                    })
                );

                // Models are private project assets. Retrieve their recorded storage paths and
                // hand the viewer a signed URL instead of guessing public bucket locations.
                try {
                    const { data: reconstructedModels, error: modelsError } = await supabase
                        .from('reconstructed_models')
                        .select('*')
                        .in('project_id', projectIds)
                        .order('created_at', { ascending: false });

                    if (modelsError) throw modelsError;

                    for (const row of (reconstructedModels || []) as ReconstructedModelRow[]) {
                        const projectId = row.project_id;
                        const storagePath = getReconstructedModelPath(row);
                        if (!projectId || !storagePath || spzUrlByProject.has(projectId)) continue;

                        const { data: signedFile, error: signedUrlError } = await supabase.storage
                            .from('project-images')
                            .createSignedUrl(storagePath, 60 * 60);

                        if (signedUrlError) {
                            console.warn(`Could not sign SPZ model for project ${projectId}:`, signedUrlError);
                            continue;
                        }
                        if (signedFile?.signedUrl) spzUrlByProject.set(projectId, signedFile.signedUrl);
                    }
                } catch (spzFetchErr) {
                    console.warn('Could not load reconstructed SPZ models:', spzFetchErr);
                }

                // Some reconstruction workers write the completed file directly to
                // project-images/<project_id>/ (for example prism_scene_000100.spz)
                // before, or without, recording a row in reconstructed_models.
                // Keep the table as the preferred source, then find that project's
                // actual SPZ asset and sign it rather than dropping to the demo.
                for (const projectId of projectIds) {
                    if (spzUrlByProject.has(projectId)) continue;
                    try {
                        const { data: files, error: listError } = await supabase.storage
                            .from('project-images')
                            .list(projectId, { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });
                        if (listError) throw listError;

                        const model = files?.find((file) => file.name.toLowerCase().endsWith('.spz'));
                        if (!model) continue;

                        const { data: signedFile, error: signedUrlError } = await supabase.storage
                            .from('project-images')
                            .createSignedUrl(`${projectId}/${model.name}`, 60 * 60);
                        if (signedUrlError) throw signedUrlError;
                        if (signedFile?.signedUrl) spzUrlByProject.set(projectId, signedFile.signedUrl);
                    } catch (storageLookupError) {
                        console.warn(`Could not locate SPZ model for project ${projectId}:`, storageLookupError);
                    }
                }
            }

            const mapped: ProjectJob[] = rawProjects.map((row) => {
                const job = mapSupabaseRowToJob(row as SupabaseProjectRow);
                const projectImagePaths = imagePathsByProject.get(job.id) || [];
                const randomThumb = randomThumbnailByProject.get(job.id);

                if (randomThumb) {
                    job.thumbnailUrl = randomThumb;
                    job.photos = [randomThumb];
                }
                if (projectImagePaths.length > 0) {
                    job.photographsCount = projectImagePaths.length;
                }
                const foundSpz = spzUrlByProject.get(job.id);
                if (foundSpz) {
                    job.modelPath = foundSpz;
                }
                return job;
            });
            setProjects(mapped);
            if (mapped.length > 0) {
                setActiveProjectId((prev) => (prev ? prev : mapped[0].id));
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unable to connect to Supabase.';
            setProjectsError(message);
        } finally {
            setIsLoadingProjects(false);
        }
    }, []);

    useEffect(() => {
        if (isDemoOnlyEnv && typeof window !== 'undefined' && window.location.pathname !== '/demo') {
            window.history.replaceState({}, '', '/demo');
        }
        const handleLocationChange = () => {
            setIsDemo(checkIsDemoRoute());
        };
        window.addEventListener('popstate', handleLocationChange);
        return () => {
            window.removeEventListener('popstate', handleLocationChange);
        };
    }, []);

    useEffect(() => {
        if (isDemo) return;
        // Automatically ensure anonymous session exists on startup and load projects
        ensureSession()
            .then(() => fetchProjects())
            .catch((err) => {
                console.error('Session startup error:', err);
                fetchProjects();
            });
    }, [fetchProjects, isDemo]);

    const handleStartCreateProject = () => {
        setCreateProjectError(null);
        setUploadProgress(null);
        setUploadError(null);
        setActiveProjectId('');
        setCommittedDraftProjectId(null);
        setDraftProject(null);
        setTransitionState('exiting-projects');
        setTimeout(() => {
            setView('create-project');
            setTransitionState('idle');
        }, 200);
    };

    const handleBackFromCreate = () => {
        setCreateProjectError(null);
        setTransitionState('exiting-create');
        setTimeout(() => {
            if (draftProject?.photos && draftProject.photos.length > 0) {
                setView('upload-photos');
            } else {
                setDraftProject(null);
                setCommittedDraftProjectId(null);
                setActiveProjectId('');
                setView('projects');
            }
            setTransitionState('idle');
        }, 180);
    };

    const updateProjects = (newProjects: ProjectJob[]) => {
        setProjects(newProjects);
    };

    const activeProject =
        projects.find((p) => p.id === activeProjectId) ||
        (committedDraftProjectId ? projects.find((p) => p.id === committedDraftProjectId) : undefined) ||
        projects[0];

    const handleCreateProjectSubmit = (data: { name: string; description: string; photos: string[] }) => {
        // 1. If user is editing an already-persisted project (has valid existing project_id), update it in Supabase
        if (activeProjectId && activeProjectId !== 'draft' && !committedDraftProjectId) {
            const existing = projects.find((p) => p.id === activeProjectId);
            if (existing) {
                supabase
                    .from('projects')
                    .update({ name: data.name })
                    .eq('project_id', activeProjectId)
                    .then(({ error }) => {
                        if (error) console.error('Error updating existing project name:', error.message);
                    });

                const updated = projects.map((p) =>
                    p.id === activeProjectId
                        ? { ...p, name: data.name, description: data.description }
                        : p
                );
                updateProjects(updated);
            }
        }

        // 2. Purely store draft details in local state. DO NOT create rows in projects table yet!
        setDraftProject((prev) => ({
            name: data.name,
            description: data.description,
            photos: data.photos && data.photos.length > 0 ? data.photos : (prev?.photos || []),
            fileMap: prev?.fileMap
        }));

        // 3. Move to upload-photographs view
        setView('upload-photos');
    };

    const handleUploadContinue = async (payload: {
        projectId?: string;
        photos: string[];
        fileMap: Map<string, File>;
    }) => {
        // START RECONSTRUCTION:
        // This is the first point where the new project is persisted to Supabase!
        // 1. Ensure anonymous session and DB session row exist
        const sessionId = await ensureSession();

        let targetProjectId = (activeProjectId && activeProjectId !== 'draft')
            ? activeProjectId
            : (committedDraftProjectId || (payload.projectId && payload.projectId !== 'draft' ? payload.projectId : null));

        // If new project that hasn't been created yet, create exactly one row in projects table
        if (!targetProjectId || targetProjectId === 'draft') {
            const { data: insertedData, error: insertError } = await supabase
                .from('projects')
                .insert({
                    session_id: sessionId,
                    name: draftProject?.name?.trim() || 'Indoor Reconstruction',
                    status: 'pending'
                })
                .select('project_id, session_id, name, status, created_at')
                .single();

            if (insertError || !insertedData) {
                throw new Error(insertError?.message || 'Failed to create project in Supabase.');
            }

            targetProjectId = (insertedData as SupabaseProjectRow).project_id;
            setCommittedDraftProjectId(targetProjectId);
            setActiveProjectId(targetProjectId);

            const firstThumb = payload.photos[0] || '';
            const newJob = mapSupabaseRowToJob(insertedData as SupabaseProjectRow);
            newJob.description = draftProject?.description || '';
            newJob.photos = payload.photos;
            newJob.photographsCount = payload.photos.length;
            newJob.thumbnailUrl = firstThumb;
            newJob.status = 'processing';

            setProjects((prev) => [newJob, ...prev.filter((p) => p.id !== newJob.id)]);
        } else {
            setActiveProjectId(targetProjectId);
        }

        // 2. Create exactly one reconstruction_jobs row for the project BEFORE uploading
        const { data: existingJobs } = await supabase
            .from('reconstruction_jobs')
            .select('job_id')
            .eq('project_id', targetProjectId)
            .limit(1);

        if (!existingJobs || existingJobs.length === 0) {
            const { error: jobError } = await supabase
                .from('reconstruction_jobs')
                .insert({
                    project_id: targetProjectId,
                    status: 'pending',
                    stage: 'Image Ingestion'
                });

            if (jobError) {
                throw new Error(`Failed to initialize reconstruction job: ${jobError.message}`);
            }
        }

        // 3. Update state and IMMEDIATELY transition to Reconstruction Status / Processing screen
        const projectName = draftProject?.name?.trim() || 'Indoor Reconstruction';
        const projectDesc = draftProject?.description || '';

        setProjects((prev) => {
            const firstThumb = payload.photos[0] || '';
            const existing = prev.find((p) => p.id === targetProjectId);
            if (existing) {
                return prev.map((p) => {
                    if (p.id === targetProjectId) {
                        return {
                            ...p,
                            name: p.name || projectName,
                            description: p.description || projectDesc,
                            photographsCount: payload.photos.length,
                            status: 'processing' as const,
                            currentStep: 1,
                            thumbnailUrl: p.thumbnailUrl || firstThumb,
                            photos: payload.photos
                        };
                    }
                    return p;
                });
            } else {
                const committedJob: ProjectJob = {
                    id: targetProjectId,
                    name: projectName,
                    description: projectDesc,
                    dateCreated: formatProjectDate(new Date().toISOString()),
                    photographsCount: payload.photos.length,
                    status: 'processing' as const,
                    currentStep: 1,
                    thumbnailUrl: firstThumb,
                    modelFormat: '3D Gaussian Splat (.spz)',
                    modelPath: '',
                    shareUrl: '',
                    photos: payload.photos
                };
                return [committedJob, ...prev];
            }
        });

        setActiveProjectId(targetProjectId);
        setUploadError(null);
        setUploadProgress({ uploaded: 0, total: payload.photos.length });
        setDraftProject(null);
        setCommittedDraftProjectId(null);
        setView('processing');

        // 4. Asynchronously upload images to project-images/{targetProjectId}/{image_id}.{extension}
        const { data: existingRows } = await supabase
            .from('uploaded_images')
            .select('file_path')
            .eq('project_id', targetProjectId);

        const existingPaths = new Set((existingRows || []).map((r) => r.file_path));
        const newlyUploadedStoragePaths: string[] = [];
        const newlyInsertedDbFilePaths: string[] = [];
        let successfulUploads = 0;

        try {
            for (let i = 0; i < payload.photos.length; i++) {
                const photoRef = payload.photos[i];
                const localFile = payload.fileMap.get(photoRef);

                let fileBlob: Blob;
                let extension = 'jpg';

                if (localFile) {
                    fileBlob = localFile;
                    const detectedExt = (localFile.name.split('.').pop() || '').toLowerCase();
                    if (detectedExt) extension = detectedExt;
                } else {
                    const res = await fetch(photoRef);
                    if (!res.ok) throw new Error(`Failed to load image for upload (#${i + 1}).`);
                    fileBlob = await res.blob();
                    if (fileBlob.type.includes('png')) extension = 'png';
                }

                // Store reconstruction-ready images, not the full-resolution raw capture.
                // Images already at or below 2048px are returned untouched.
                fileBlob = await resizeImageForUpload(fileBlob);

                const imageId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
                const storagePath = `${targetProjectId}/${imageId}.${extension}`;
                const fullFilePath = `project-images/${storagePath}`;

                const { error: storageError } = await supabase.storage
                    .from('project-images')
                    .upload(storagePath, fileBlob, {
                        contentType: fileBlob.type || `image/${extension}`,
                        upsert: false
                    });

                if (storageError) {
                    throw new Error(`Storage upload failed: ${storageError.message}`);
                }

                newlyUploadedStoragePaths.push(storagePath);

                if (!existingPaths.has(fullFilePath)) {
                    const { error: dbError } = await supabase
                        .from('uploaded_images')
                        .insert({
                            project_id: targetProjectId,
                            file_path: fullFilePath,
                            uploaded_at: new Date().toISOString()
                        });

                    if (dbError) {
                        throw new Error(`Failed to record image metadata: ${dbError.message}`);
                    }
                    newlyInsertedDbFilePaths.push(fullFilePath);
                    existingPaths.add(fullFilePath);
                }

                // Increment ONLY after BOTH storage upload and metadata insertion succeed
                successfulUploads++;
                setUploadProgress({ uploaded: successfulUploads, total: payload.photos.length });
            }

            // 5. Advance to Spatial Reconstruction once all images and metadata have successfully uploaded
            if (successfulUploads === payload.photos.length) {
                const { error: updateJobError } = await supabase
                    .from('reconstruction_jobs')
                    .update({
                        stage: 'Spatial Reconstruction',
                        status: 'running',
                        started_at: new Date().toISOString()
                    })
                    .eq('project_id', targetProjectId);

                if (updateJobError) {
                    console.warn('Failed to advance reconstruction job stage:', updateJobError.message);
                }

                await supabase
                    .from('projects')
                    .update({ status: 'processing' })
                    .eq('project_id', targetProjectId);

                setProjects((prev) =>
                    prev.map((p) => {
                        if (p.id === targetProjectId) {
                            return {
                                ...p,
                                status: 'processing' as const,
                                currentStep: 2
                            };
                        }
                        return p;
                    })
                );
            }
        } catch (uploadError) {
            // FAILURE HANDLING:
            // Clean up partially uploaded Storage objects and related metadata from this attempt
            if (newlyUploadedStoragePaths.length > 0) {
                try {
                    await supabase.storage.from('project-images').remove(newlyUploadedStoragePaths);
                } catch (cleanupStorageErr) {
                    console.warn('Failed to clean up storage objects:', cleanupStorageErr);
                }
            }
            if (newlyInsertedDbFilePaths.length > 0) {
                try {
                    await supabase
                        .from('uploaded_images')
                        .delete()
                        .eq('project_id', targetProjectId)
                        .in('file_path', newlyInsertedDbFilePaths);
                } catch (cleanupDbErr) {
                    console.warn('Failed to clean up uploaded_images metadata:', cleanupDbErr);
                }
            }

            try {
                await supabase
                    .from('reconstruction_jobs')
                    .update({ status: 'failed' })
                    .eq('project_id', targetProjectId);
            } catch (failErr) {
                console.warn('Failed to update reconstruction job to failed:', failErr);
            }

            const errorMsg = uploadError instanceof Error ? uploadError.message : 'Upload failed.';
            setUploadError(errorMsg);
            setProjects((prev) =>
                prev.map((p) => {
                    if (p.id === targetProjectId) {
                        return {
                            ...p,
                            status: 'failed' as const
                        };
                    }
                    return p;
                })
            );
        }
    };

    const handleProcessingComplete = (spzUrl?: string) => {
        setProjects((prev) =>
            prev.map((p) => {
                if (p.id === activeProjectId) {
                    return {
                        ...p,
                        status: 'completed' as const,
                        currentStep: 5,
                        ...(spzUrl ? { modelPath: spzUrl } : {})
                    };
                }
                return p;
            })
        );
        // Stay on canonical Reconstruction Status screen where state transitions to completed
    };

    const handleViewProject = (projectId: string) => {
        setActiveProjectId(projectId);
        setUploadProgress(null);
        setUploadError(null);
        setView('processing');
    };

    const handleDeleteProject = async (projectId: string) => {
        const previousProjects = projects;

        // Optimistically remove from state
        setProjects((prev) => {
            const updated = prev.filter((p) => p.id !== projectId);
            if (activeProjectId === projectId && updated.length > 0) {
                setActiveProjectId(updated[0].id);
            } else if (activeProjectId === projectId) {
                setActiveProjectId('');
            }
            return updated;
        });

        try {
            // 1. Delete associated storage objects in project-images/{projectId}/
            try {
                const { data: files } = await supabase.storage
                    .from('project-images')
                    .list(projectId, { limit: 1000 });

                if (files && files.length > 0) {
                    const pathsToRemove = files.map((f) => `${projectId}/${f.name}`);
                    await supabase.storage.from('project-images').remove(pathsToRemove);
                }
            } catch (storageErr) {
                console.warn('Failed to clean up storage objects for project:', storageErr);
            }

            // 2. Delete rows in child tables first to respect foreign keys
            try {
                await supabase.from('reconstructed_models').delete().eq('project_id', projectId);
            } catch (e) {
                console.warn('reconstructed_models delete warning:', e);
            }

            try {
                await supabase.from('reconstruction_jobs').delete().eq('project_id', projectId);
            } catch (e) {
                console.warn('reconstruction_jobs delete warning:', e);
            }

            try {
                await supabase.from('uploaded_images').delete().eq('project_id', projectId);
            } catch (e) {
                console.warn('uploaded_images delete warning:', e);
            }

            // 3. Delete from projects table
            const { error: projError } = await supabase
                .from('projects')
                .delete()
                .eq('project_id', projectId);

            if (projError) {
                throw new Error(projError.message);
            }
        } catch (err: unknown) {
            console.error('Failed to delete project:', err);
            // Rollback optimistic update on error
            setProjects(previousProjects);
            const msg = err instanceof Error ? err.message : 'Unknown error';
            alert(`Failed to delete project: ${msg}`);
        }
    };

    const handleStepUpdate = (step: number) => {
        setProjects((prev) =>
            prev.map((p) => {
                if (p.id === activeProjectId) {
                    return { ...p, currentStep: step };
                }
                return p;
            })
        );
    };

    if (isDemo) {
        return (
            <div className="fixed inset-0 w-screen h-screen bg-[#090b0e] z-50 flex flex-col overflow-hidden">
                {/* Minimal Demo Top Bar */}
                <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between bg-[#080d17]/95 backdrop-blur-md z-20">
                    <div className="flex items-center gap-3">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#ea580c] animate-ping" />
                        <div>
                            <h1 className="text-white font-semibold text-sm sm:text-base tracking-wide flex items-center gap-2">
                                <span>PRISM Interactive Demo</span>
                                <span className="text-[10px] px-2 py-0.5 rounded bg-[#ea580c]/20 text-[#ea580c] font-mono border border-[#ea580c]/40 font-bold uppercase tracking-wider">
                                    STANDALONE VIEWER
                                </span>
                            </h1>
                            <span className="text-[11px] text-slate-400 font-mono">
                                Auto-loaded /DemoModelling.spz • WebGPU / WebGL2 Drone Camera
                            </span>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {!isDemoOnlyEnv ? (
                            <button
                                onClick={() => {
                                    window.history.pushState({}, '', '/');
                                    setIsDemo(false);
                                }}
                                className="px-3.5 py-1.5 rounded-lg border border-[#ea580c]/40 bg-[#ea580c]/15 hover:bg-[#ea580c]/25 text-xs font-mono text-[#ea580c] hover:text-white transition-all cursor-pointer flex items-center gap-1.5"
                            >
                                <span>Open Workspace</span>
                                <span className="text-xs">→</span>
                            </button>
                        ) : (
                            <a
                                href="https://github.com/SynCarter/PRISM"
                                target="_blank"
                                rel="noreferrer"
                                className="px-3.5 py-1.5 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-xs font-mono text-slate-300 hover:text-white transition-all flex items-center gap-1.5"
                            >
                                <span>GitHub Repository</span>
                                <span className="text-xs">↗</span>
                            </a>
                        )}
                    </div>
                </div>

                {/* Standalone Fullscreen SpzViewer */}
                <div className="relative flex-1 w-full h-full bg-[#090b0e] overflow-hidden">
                    <SpzViewer spzUrl="/DemoModelling.spz" />
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#05070b] text-[#f1f4f9] selection:bg-[#ea580c] selection:text-white">
            {/* Screen 1: Spatial Entry & Chambers Tour (Horizontal Sliding ONLY for Intro) */}
            {view === 'tour' && (
                <SpatialTour onEnterWorkspace={() => setView('projects')} />
            )}

            {/* Screen 2: Projects Dashboard (Standard Page) */}
            {view === 'projects' && (
                <div
                    className={
                        transitionState === 'exiting-projects'
                            ? 'animate-page-exit pointer-events-none'
                            : 'animate-page-enter'
                    }
                >
                    <ProjectsDashboard
                        projects={projects}
                        isLoading={isLoadingProjects}
                        errorMessage={projectsError}
                        onRetry={fetchProjects}
                        onCreateProject={handleStartCreateProject}
                        onViewProject={handleViewProject}
                        onDeleteProject={handleDeleteProject}
                        onReplayTour={() => setView('tour')}
                    />
                </div>
            )}

            {/* Screen 3: Create Project Form (Standard Page) */}
            {view === 'create-project' && (
                <div
                    className={
                        transitionState === 'exiting-create'
                            ? 'animate-page-exit pointer-events-none'
                            : 'animate-page-enter'
                    }
                >
                    <CreateProject
                        initialName={draftProject?.name || (activeProjectId && activeProjectId !== 'draft' ? activeProject?.name : '')}
                        initialDescription={draftProject?.description || (activeProjectId && activeProjectId !== 'draft' ? activeProject?.description : '')}
                        initialPhotos={draftProject?.photos || (activeProjectId && activeProjectId !== 'draft' ? activeProject?.photos : [])}
                        isSubmitting={isCreatingProject}
                        errorMessage={createProjectError}
                        onBack={handleBackFromCreate}
                        onSubmit={handleCreateProjectSubmit}
                    />
                </div>
            )}

            {/* Screen 4: Upload Photographs & Validate (Standard Page) */}
            {view === 'upload-photos' && (
                <UploadPhotographs
                    project={{
                        id: activeProjectId || committedDraftProjectId || 'draft',
                        name: draftProject?.name || (activeProjectId && activeProjectId !== 'draft' ? activeProject?.name : '') || 'New Reconstruction',
                        description: draftProject?.description || (activeProjectId && activeProjectId !== 'draft' ? activeProject?.description : '') || '',
                        dateCreated: activeProjectId && activeProjectId !== 'draft' ? activeProject?.dateCreated || 'Draft' : 'Draft',
                        photographsCount: draftProject?.photos?.length || (activeProjectId && activeProjectId !== 'draft' ? activeProject?.photographsCount : 0) || 0,
                        status: activeProject?.status || 'pending',
                        currentStep: activeProject?.currentStep || 1,
                        thumbnailUrl: draftProject?.photos?.[0] || activeProject?.thumbnailUrl || '',
                        modelFormat: '3D Gaussian Splat (.spz)',
                        modelPath: activeProject?.modelPath || '',
                        shareUrl: activeProject?.shareUrl || '',
                        photos: draftProject?.photos && draftProject.photos.length > 0 ? draftProject.photos : (activeProject?.photos || [])
                    }}
                    initialFileMap={draftProject?.fileMap}
                    onBack={() => {
                        setDraftProject(null);
                        setCommittedDraftProjectId(null);
                        setActiveProjectId('');
                        setView('projects');
                    }}
                    onPhotosChange={(updatedPhotos, updatedFileMap) => {
                        setDraftProject((prev) =>
                            prev
                                ? { ...prev, photos: updatedPhotos, fileMap: updatedFileMap || prev.fileMap }
                                : { name: '', description: '', photos: updatedPhotos, fileMap: updatedFileMap }
                        );
                    }}
                    onEditDetails={(currentPhotos, currentFileMap) => {
                        setDraftProject((prev) =>
                            prev
                                ? { ...prev, photos: currentPhotos, fileMap: currentFileMap || prev.fileMap }
                                : { name: '', description: '', photos: currentPhotos, fileMap: currentFileMap }
                        );
                        setView('create-project');
                    }}
                    onContinue={handleUploadContinue}
                />
            )}

            {/* Screen 5: Reconstruction Status & Processing (Standard Page) */}
            {view === 'processing' && (
                <ProcessingScreen
                    project={
                        activeProject || {
                            id: activeProjectId || committedDraftProjectId || '',
                            name: draftProject?.name || 'Indoor Reconstruction',
                            description: draftProject?.description || '',
                            dateCreated: formatProjectDate(new Date().toISOString()),
                            photographsCount: 0,
                            status: 'processing',
                            currentStep: 1,
                            thumbnailUrl: '',
                            photos: []
                        }
                    }
                    uploadProgress={uploadProgress}
                    uploadError={uploadError}
                    onBackToProjects={() => setView('projects')}
                    onComplete={handleProcessingComplete}
                    onUpdateStep={handleStepUpdate}
                    onNavigateToDetails={() => setView('create-project')}
                    onNavigateToUpload={() => setView('upload-photos')}
                />
            )}

            {/* Screen 6: Canonical Reconstruction Status Screen (Completed & Processing) */}
            {view === 'project-detail' && (
                <ProcessingScreen
                    project={
                        activeProject || {
                            id: activeProjectId || '',
                            name: 'Indoor Reconstruction',
                            description: '',
                            dateCreated: formatProjectDate(new Date().toISOString()),
                            photographsCount: 0,
                            status: 'completed',
                            currentStep: 5,
                            thumbnailUrl: '',
                            photos: []
                        }
                    }
                    uploadProgress={uploadProgress}
                    uploadError={uploadError}
                    onBackToProjects={() => setView('projects')}
                    onComplete={handleProcessingComplete}
                    onUpdateStep={handleStepUpdate}
                    onNavigateToDetails={() => setView('create-project')}
                    onNavigateToUpload={() => setView('upload-photos')}
                />
            )}
        </div>
    );
}
