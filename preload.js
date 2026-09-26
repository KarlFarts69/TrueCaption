const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Threat model, stated plainly because the next three lines look alarming
// out of context: TrueCaption is a single-user desktop app. It loads no
// remote content, has no network surface, opens no user-supplied HTML, and
// its renderer is the app's own code. dbAll/dbGet/dbRun hand arbitrary SQL
// to a local SQLite file the user already owns outright — there is no
// privilege boundary here to cross, and nothing to escalate to.
//
// What DOES matter is contextIsolation: true and nodeIntegration: false in
// main.js, plus javascript: false on the PDF render window. Those are the
// real boundary, and they are set. If this app ever renders remote content
// or gains multi-user data, this bridge has to be narrowed to named,
// parameterised queries first.
contextBridge.exposeInMainWorld('api', {
  dbAll: (sql, params) => ipcRenderer.invoke('db-all', sql, params),
  dbGet: (sql, params) => ipcRenderer.invoke('db-get', sql, params),
  dbRun: (sql, params) => ipcRenderer.invoke('db-run', sql, params),
  // A batch that commits together or not at all — see main.js 'db-transaction'.
  dbTransaction: (statements) => ipcRenderer.invoke('db-transaction', statements),
  generatePdf: (html, matter, docTypeLabel, docType) => ipcRenderer.invoke('generate-pdf', html, matter, docTypeLabel, docType),
  generateDocx: (blocks, matter, settings, docTypeLabel, docType) => ipcRenderer.invoke('generate-docx', blocks, matter, settings, docTypeLabel, docType),
  // These three take a STORED location (straight from a database column) or
  // an absolute one, and resolve it in main against the output root.
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  pathExists: (p) => ipcRenderer.invoke('path-exists', p),
  pickSignatureImage: () => ipcRenderer.invoke('pick-signature-image'),
  pickLetterScan: () => ipcRenderer.invoke('pick-letter-scan'),
  saveAttachedFile: (dataUri, matter, docTypeLabel, docType) =>
    ipcRenderer.invoke('save-attached-file', dataUri, matter, docTypeLabel, docType),
  // A client's scanned-paperwork folder — see main.js getClientDir. Frozen on
  // people.client_docs_dir the first time it is asked for.
  clientDocsDir: (personId) => ipcRenderer.invoke('client-docs-dir', personId),
  // Each of a client's uploaded files, resolved in main: { [row id]: path }.
  clientDocumentPaths: (personId) => ipcRenderer.invoke('client-document-paths', personId),
  // The case screen's Open Folder and Add Documents — see main.js.
  matterFolder: (matterId) => ipcRenderer.invoke('matter-folder', matterId),
  clientFolder: (personId) => ipcRenderer.invoke('client-folder', personId),
  caseUploadOwner: (matterId) => ipcRenderer.invoke('case-upload-owner', matterId),
  // The folder-owner picker: which client's folder a shared (or client-less)
  // case is saved in. The choice is refused once the case folder is frozen.
  matterFolderCandidates: (matterId) => ipcRenderer.invoke('matter-folder-candidates', matterId),
  setMatterFolderOwner: (matterId, personId) =>
    ipcRenderer.invoke('set-matter-folder-owner', matterId, personId),
  addClientDocument: (personId, opts) => ipcRenderer.invoke('add-client-document', personId, opts),
  // Same copy without the dialog: drag-and-drop, and the smoke harness.
  addClientDocumentFiles: (personId, filePaths, opts) =>
    ipcRenderer.invoke('add-client-document-files', personId, filePaths, opts),
  // The on-disk path behind a dropped File. Electron 32 REMOVED the old
  // non-standard `File.path` property, so a drop handler that reads `file.path`
  // gets undefined and silently adds nothing; webUtils.getPathForFile is the
  // supported replacement and it only works here, in the preload. Returns ''
  // for a File that was built in JS and is not backed by a file on disk.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  backupNow: () => ipcRenderer.invoke('backup-now'),
  restoreBackup: () => ipcRenderer.invoke('restore-backup'),
  appVersion: () => ipcRenderer.invoke('app-version'),
  // App zoom (main.js ZOOM_STEPS): { factor, steps }, and set -> the step used.
  getZoom: () => ipcRenderer.invoke('get-zoom'),
  setZoom: (factor) => ipcRenderer.invoke('set-zoom', factor),
  // Main changed it (the keyboard shortcuts are handled there).
  onZoomChanged: (cb) => { ipcRenderer.on('zoom-changed', (_e, factor) => cb(factor)); },
  // The documents-folder banner text while that folder is not available
  // (main.js rootRefusal), or null. Asked afresh each time.
  outputRootStatus: () => ipcRenderer.invoke('output-root-status'),
  chooseOutputRoot: () => ipcRenderer.invoke('choose-output-root'),
  readPrintCss: () => ipcRenderer.invoke('read-print-css')
});
