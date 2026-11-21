import { supabase } from './supabase';

/**
 * Fetches the actual SPZ model URL from the respective Supabase bucket or reconstructed_models table.
 * Checks reconstructed_models table first, then scans project-images/{projectId}/ for *.spz files.
 */
export async function getProjectSpzUrl(
  projectId: string,
  existingModelPath?: string
): Promise<string | null> {
  // 1. If existingModelPath is already a valid remote signed URL (not DemoModelling.spz)
  if (
    existingModelPath &&
    !existingModelPath.includes('DemoModelling.spz') &&
    (existingModelPath.startsWith('http://') || existingModelPath.startsWith('https://'))
  ) {
    return existingModelPath;
  }

  if (!projectId || projectId === 'draft') return null;

  // 2. Query reconstructed_models table in Supabase
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

        // If candidate is already an absolute HTTP/HTTPS URL
        if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
          const bucketPrefix = 'project-images/';
          const bucketIndex = candidate.indexOf(bucketPrefix);
          if (bucketIndex !== -1) {
            const pathPart = decodeURIComponent(
              candidate.slice(bucketIndex + bucketPrefix.length).split('?')[0]
            );
            const { data: signed } = await supabase.storage
              .from('project-images')
              .createSignedUrl(pathPart, 60 * 60);
            if (signed?.signedUrl) return signed.signedUrl;
          }
          return candidate;
        }

        // If candidate is a relative or bucket storage path
        let cleanPath = candidate.startsWith('project-images/')
          ? candidate.slice('project-images/'.length)
          : candidate;
        if (cleanPath.startsWith('/')) cleanPath = cleanPath.slice(1);

        const { data: signedFile, error: signErr } = await supabase.storage
          .from('project-images')
          .createSignedUrl(cleanPath, 60 * 60);

        if (!signErr && signedFile?.signedUrl) {
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
    console.warn('Error checking reconstructed_models for SPZ:', err);
  }

  // 3. Scan the project's folder in the project-images bucket for any *.spz files
  try {
    const { data: files, error: listError } = await supabase.storage
      .from('project-images')
      .list(projectId, { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });

    if (!listError && files && files.length > 0) {
      const spzFile = files.find((f) => f.name.toLowerCase().endsWith('.spz'));
      if (spzFile) {
        const { data: signedFile, error: signErr } = await supabase.storage
          .from('project-images')
          .createSignedUrl(`${projectId}/${spzFile.name}`, 60 * 60);

        if (!signErr && signedFile?.signedUrl) {
          return signedFile.signedUrl;
        }

        const pubUrl = supabase.storage
          .from('project-images')
          .getPublicUrl(`${projectId}/${spzFile.name}`).data.publicUrl;
        if (pubUrl) return pubUrl;
      }
    }
  } catch (err) {
    console.warn(`Error scanning project-images/${projectId} for SPZ:`, err);
  }

  return null;
}

/**
 * Downloads an SPZ file by fetching it as a blob and triggering a browser download
 * with the specified filename (<projectName>.spz).
 */
export async function downloadSpzFile(spzUrl: string, filename: string): Promise<void> {
  const cleanFilename = (filename || 'reconstruction').trim().replace(/[/\\?%*:|"<>]/g, '_');
  const finalFilename = cleanFilename.toLowerCase().endsWith('.spz')
    ? cleanFilename
    : `${cleanFilename}.spz`;

  const response = await fetch(spzUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch SPZ file (HTTP ${response.status})`);
  }

  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = finalFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Revoke the blob URL after download initiates
  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 2000);
}
