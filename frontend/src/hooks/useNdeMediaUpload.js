import { useState, useCallback } from 'react'
import { useNdeClient } from './useNdeClient.js'

/**
 * Media / file upload hook.
 *
 * Flow:
 *   1. POST {httpUrl}/upload/presign  → { uploadUrl, fileUrl, fileId }
 *   2. PUT  uploadUrl (direct to storage, with XHR for progress events)
 *   3. client.sendAttachment(convId, meta, caption)
 *
 * Requires SyncClient to be created with `httpUrl` set in NdeChatProvider.
 *
 * Returns:
 *   upload(file, { caption? })  — async upload + send
 *   uploading  boolean
 *   progress   0–100
 *   error      string | null
 *   reset()    — clear error / progress state
 */
export function useNdeMediaUpload(convId) {
  const client = useNdeClient()
  const [uploading, setUploading] = useState(false)
  const [progress,  setProgress]  = useState(0)
  const [error,     setError]     = useState(null)

  const reset = useCallback(() => {
    setUploading(false)
    setProgress(0)
    setError(null)
  }, [])

  const upload = useCallback(async (file, { caption = '' } = {}) => {
    if (!client._httpUrl) {
      setError('httpUrl not configured — pass httpUrl to NdeChatProvider.')
      return
    }
    setUploading(true)
    setProgress(0)
    setError(null)

    try {
      // 1. Get presigned upload URL
      const token  = await client._getToken().catch(() => '')
      const presignRes = await fetch(`${client._httpUrl}/upload/presign`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          filename:  file.name,
          size:      file.size,
          mimeType:  file.type,
          convId,
        }),
      })
      if (!presignRes.ok) throw new Error(`Presign failed: ${presignRes.status}`)
      const { uploadUrl, fileUrl, fileId } = await presignRes.json()

      // 2. Upload directly to storage (XHR for progress events)
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
        }
        xhr.onload  = () => xhr.status < 400 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`))
        xhr.onerror = () => reject(new Error('Network error during upload'))
        xhr.open('PUT', uploadUrl)
        xhr.setRequestHeader('Content-Type', file.type)
        xhr.send(file)
      })

      // 3. Send message with attachment metadata
      client.sendAttachment(convId, {
        fileId, fileUrl,
        filename: file.name,
        size:     file.size,
        mimeType: file.type,
      }, caption)

      setProgress(100)
    } catch (e) {
      setError(e.message ?? 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [client, convId])

  return { upload, uploading, progress, error, reset }
}
