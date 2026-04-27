  You are implementing two coordinated changes to a Paperclip adapter plugin.                                                                                                                      
  The repo is at /Users/Repositories/paperclip-adapter-opencode-k8s on branch                                                                                                                      
  master. Work on a new branch off master — do NOT commit directly to master.                                                                                                                      
                                                                                                                                                                                                   
  Before you start, read these files fully:                                                                                                                                                        
    - src/server/execute.ts (~1218 lines; this is the main file you'll edit)                                                                                                                       
    - src/server/job-manifest.ts                                                                                                                                                                   
    - src/server/log-dedup.ts (you will delete this)                                                                                                                                               
    - src/server/parse.ts                                                                                                                                                                          
    - src/server/index.ts                                                                                                                                                                          
    - src/index.ts                                                                                                                                                                                 
                                                                                                                                                                                                   
  Run `npm install` and then `npm test`. Confirm green. Note the test count                                                                                                                        
  for later comparison. Do NOT run `npm run build` — CI handles that.                                                                                                                              
                                                                                                                                                                                                   
  =============================================================================                                                                                                                    
  WHY WE ARE DOING THIS                                                                                                                                                                            
  =============================================================================                                                                                                                    
                                                                                                                                                                                                   
  Two tightly coupled bugs:                                                                                                                                                                        
                                                                                                                                                                                                   
  (A) The adapter doesn't declare `hasOutOfProcessLiveness: true` on its                                                                                                                           
      ServerAdapterModule. The revitalize reaper therefore treats it as an
      in-process adapter, expects a local child PID, finds none, and marks                                                                                                                         
      every run `process_lost` after 5 minutes of staleness.                                                                                                                                       
                                                                                                                                                                                                   
  (B) The adapter reads pod logs via the Kubernetes log API (follow mode).                                                                                                                         
      At production scale the stream drops every few seconds, exhausting                                                                                                                           
      the 50-reconnect cap within 2.5 minutes. Long runs lose live UI                                                                                                                              
      output, and combined with (A) they fail entirely.                                                                                                                                            
                                                                                                                                                                                                   
  Fix both in one PR:                                                                                                                                                                              
                                                                                                                                                                                                   
    1. Declare `hasOutOfProcessLiveness: true` in createServerAdapter().                                                                                                                           
    2. Have the pod tee opencode's stdout to a file on the shared PVC, and
       have the adapter tail that file from the Paperclip server process.                                                                                                                          
                                                                                                                                                                                                   
  We are NOT going to:                                                                                                                                                                             
    - wrap the opencode binary                                                                                                                                                                     
    - use hooks                                                                                                                                                                                    
    - add a sidecar                                                                                                                                                                                
    - change revitalize                                                                                                                                                                            
    - keep the k8s log API as a fallback                                                                                                                                                           
                                                                                                                                                                                                   
  We ARE going to:                                                                                                                                                                                 
    - replace k8s log streaming with filesystem tailing entirely                                                                                                                                   
    - delete all reconnect logic and the log-dedup filter                                                                                                                                          
    - keep `kubectl logs -f` working (tee preserves stdout)                                                                                                                                        
    - add the liveness flag so the reaper uses staleness-based liveness                                                                                                                            
                                                                                                                                                                                                   
  =============================================================================                                                                                                                    
  SCOPE OF CHANGES                                                                                                                                                                                 
  =============================================================================                                                                                                                    
                                                                                                                                                                                                   
  --- hasOutOfProcessLiveness flag (src/server/index.ts) ---                                                                                                                                       
                                                                                                                                                                                                   
  The file today returns a plain object from createServerAdapter(). Add                                                                                                                            
  `hasOutOfProcessLiveness: true` to the returned object, matching the
  pattern from paperclip-adapter-claude-k8s. The adapter-utils type predates                                                                                                                       
  this field, so the return needs a cast.                                                                                                                                                          
                                                                                                                                                                                                   
  Before (approximately):                                                                                                                                                                          
      export function createServerAdapter(): ServerAdapterModule {                                                                                                                                 
        return {                                                                                                                                                                                   
          type,                                             
          execute,                                                                                                                                                                                 
          // ... other fields ...                                                                                                                                                                  
        };                                                                                                                                                                                         
      }                                                                                                                                                                                            
                                                                                                                                                                                                   
  After:                                                                                                                                                                                           
      export function createServerAdapter(): ServerAdapterModule {
        return {                                                                                                                                                                                   
          type,                                                                                                                                                                                    
          execute,                                                                                                                                                                                 
          // ... other fields ...                                                                                                                                                                  
          // Tells the reaper to skip local PID checks and use the staleness-based                                                                                                                 
          // liveness window instead (adapter spawns K8s Jobs in separate pods).                                                                                                                   
          // Cast required: adapter-utils ServerAdapterModule type predates this field.                                                                                                            
          hasOutOfProcessLiveness: true,                                                                                                                                                           
        } as ServerAdapterModule;                                                                                                                                                                  
      }                                                                                                                                                                                            
                                                                                                                                                                                                   
  --- Job manifest (src/server/job-manifest.ts) ---                                                                                                                                                
                                                            
  1. MODIFY the main container command to tee stdout. Current code at                                                                                                                              
     approximately line 409:                                
         const mainCommand = `${configSetup}cat /tmp/prompt/prompt.txt | opencode ${opencodeArgsEscaped}`;                                                                                         
     Change to:                                                                                                                                                                                    
         const podLogPath =                                                                                                                                                                        
           `/paperclip/instances/default/run-logs/${companyId}/${agentId}/${runId}.pod.ndjson`;                                                                                                    
         const mainCommand = `${configSetup}cat /tmp/prompt/prompt.txt | opencode ${opencodeArgsEscaped} | tee ${podLogPath}`;                                                                     
                                                                                                                                                                                                   
     `companyId`, `agentId`, `runId` are already in scope in buildJobManifest                                                                                                                      
     via the destructuring at line 219 (`agent`, `runId`) — use `agent.id`                                                                                                                         
     and `agent.companyId`. If you prefer cleaner code, add a local:                                                                                                                               
         const companyId = agent.companyId;                                                                                                                                                        
         const agentId = agent.id;                                                                                                                                                                 
                                                                                                                                                                                                   
  2. MODIFY the init container command to create the parent directory before                                                                                                                       
     the main container starts. The existing init container today writes the                                                                                                                       
     prompt file with `printf`. Amend its command to also `mkdir -p` the log                                                                                                                       
     directory. The init container is at approximately line 444 (prompt                                                                                                                            
     secret path) and line 451 (direct printf path) — there are TWO init                                                                                                                           
     container variants. Amend BOTH to prepend the mkdir:                                                                                                                                          
                                                                                                                                                                                                   
     Variant 1 (large-prompt path, approx line 444):                                                                                                                                               
         Before: `cp /tmp/prompt-secret/prompt /tmp/prompt/prompt.txt`                                                                                                                             
         After:  `mkdir -p /paperclip/instances/default/run-logs/${companyId}/${agentId} && cp /tmp/prompt-secret/prompt /tmp/prompt/prompt.txt`                                                   
                                                                                                                                                                                                   
     Variant 2 (direct path, approx line 451):                                                                                                                                                     
         Before: `printf '%s' "$PROMPT_CONTENT" > /tmp/prompt/prompt.txt`                                                                                                                          
         After:  `mkdir -p /paperclip/instances/default/run-logs/${companyId}/${agentId} && printf '%s' "$PROMPT_CONTENT" > /tmp/prompt/prompt.txt`                                                
                                                                                                                                                                                                   
     Use template substitution for companyId/agentId/runId — these are all                                                                                                                         
     in scope in the builder.                                                                                                                                                                      
                                                                                                                                                                                                   
  3. EXPORT the log path builder so execute.ts can compute the same path:                                                                                                                          
         export function buildPodLogPath(companyId: string, agentId: string, runId: string): string {                                                                                              
           return `/paperclip/instances/default/run-logs/${companyId}/${agentId}/${runId}.pod.ndjson`;                                                                                             
         }                                                                                                                                                                                         
     Return this path from buildJobManifest alongside other fields in                                                                                                                              
     JobBuildResult (add `podLogPath: string` to the interface at approx                                                                                                                           
     line 46). Update the final `return { job, jobName, namespace, prompt,                                                                                                                         
     opencodeArgs, promptMetrics }` (approx line 482) to include podLogPath.                                                                                                                       
                                                                                                                                                                                                   
  4. ID SANITIZATION: before using companyId/agentId/runId in the path,                                                                                                                            
     validate they match `^[a-zA-Z0-9-]+$`. Add a helper at the top of                                                                                                                             
     job-manifest.ts:                                                                                                                                                                              
         function assertSafePathComponent(field: string, value: string): void {                                                                                                                    
           if (!/^[a-zA-Z0-9-]+$/.test(value)) {                                                                                                                                                   
             throw new Error(`Invalid ${field} for log path: ${value}`);                                                                                                                           
           }                                                                                                                                                                                       
         }                                                                                                                                                                                         
     Call it for companyId, agentId, and runId before computing podLogPath                                                                                                                         
     and before interpolating into the init container commands.                                                                                                                                    
                                                                                                                                                                                                   
  --- Adapter (src/server/execute.ts) ---                                                                                                                                                          
                                                                                                                                                                                                   
  1. DELETE the `LogLineDedupFilter` import (approx line 13).                                                                                                                                      
  2. DELETE constants (approx lines 19-26):                 
       LOG_STREAM_RECONNECT_DELAY_MS                                                                                                                                                               
       LOG_STREAM_RECONNECT_MAX_DELAY_MS                                                                                                                                                           
       MAX_LOG_RECONNECT_ATTEMPTS                                                                                                                                                                  
       LOG_STREAM_BAIL_TIMEOUT_MS                                                                                                                                                                  
  3. DELETE functions:                                                                                                                                                                             
       streamPodLogsOnce (approx line 168)                                                                                                                                                         
       streamPodLogs (approx line 252)                                                                                                                                                             
       readPodLogs (approx line 330)                                                                                                                                                               
       waitForPodTermination (approx line 355) — only used by the fallback                                                                                                                         
  4. DELETE the bail timer machinery inside any function being removed                                                                                                                             
     (bailTimer, bailResolve, bailPromise, stopPoller).                                                                                                                                            
  5. DELETE the fallback path in `execute` around lines 675-693:                                                                                                                                   
         if (!stdout.trim()) {                                                                                                                                                                     
           // ... waitForPodTermination + readPodLogs fallback                                                                                                                                     
         } else if (!parseOpenCodeJsonl(stdout).sessionId) {                                                                                                                                       
           // ... partial-stdout fallback                                                                                                                                                          
         }                                                                                                                                                                                         
                                                                                                                                                                                                   
  6. ADD a new function `tailPodLogFile` in execute.ts. Inline is fine; do                                                                                                                         
     not create a new module. Signature:                                                                                                                                                           
                                                                                                                                                                                                   
         interface TailOptions {                                                                                                                                                                   
           onLog: AdapterExecutionContext["onLog"];                                                                                                                                                
           stopSignal: { stopped: boolean };                                                                                                                                                       
         }                                                                                                                                                                                         
                                                                                                                                                                                                   
         async function tailPodLogFile(                                                                                                                                                            
           filePath: string,                                                                                                                                                                       
           opts: TailOptions,                                                                                                                                                                      
         ): Promise<string> { ... }                                                                                                                                                                
                                                                                                                                                                                                   
     Behavior:                                                                                                                                                                                     
       - Wait up to 30 seconds for the file to exist. Poll with                                                                                                                                    
         fs.promises.stat every 250ms. If the file doesn't appear in 30s,                                                                                                                          
         throw an Error: `Pod log file never appeared at ${filePath}`.                                                                                                                             
       - Once it exists, open with fs.promises.open(filePath, 'r').                                                                                                                                
       - Track a byte offset starting at 0.                                                                                                                                                        
       - Poll loop: 250ms active cadence, backs off to 1000ms if the file                                                                                                                          
         hasn't grown for 5 consecutive polls (reset to 250ms on any                                                                                                                               
         growth). For each poll:                                                                                                                                                                   
           a. stat the file, compare size to offset                                                                                                                                                
           b. if size > offset, read bytes from [offset, size) into a Buffer                                                                                                                       
           c. update offset = size                                                                                                                                                                 
           d. concatenate any pending partial line with the new buffer,                                                                                                                            
              split on '\n'                                                                                                                                                                        
           e. last element is the new pending partial line (if no trailing                                                                                                                         
              newline) or empty                                                                                                                                                                    
           f. for every complete line, call onLog("stdout", line + "\n")                                                                                                                           
              and append to an in-memory accumulator (string)                                                                                                                                      
       - Exit when opts.stopSignal.stopped === true. Before returning, do                                                                                                                          
         ONE final read-to-EOF to drain tail bytes. Close the handle.                                                                                                                              
         Return the accumulator.                                                                                                                                                                   
                                                                                                                                                                                                   
     Use fs.promises.open / FileHandle.read / FileHandle.close. Do NOT use                                                                                                                         
     fs.watch or chokidar.                                                                                                                                                                         
                                                                                                                                                                                                   
  7. REPLACE the existing log-streaming section of `execute`. Find where                                                                                                                           
     streamPodLogs is invoked inside a `Promise.allSettled` with                                                                                                                                   
     waitForJobCompletion (approx line 660). Replace that call with                                                                                                                                
     tailPodLogFile. Pattern:                                                                                                                                                                      
                                                                                                                                                                                                   
         const { /* ..., */ podLogPath } = built;                                                                                                                                                  
         // ... create secret, create job, wait for pod ...                                                                                                                                        
         const stopSignal = { stopped: false };                                                                                                                                                    
         const [tailResult, completionResult] = await Promise.allSettled([                                                                                                                         
           tailPodLogFile(podLogPath, { onLog, stopSignal }),                                                                                                                                      
           waitForJobCompletion(namespace, jobName, ...).then(r => { stopSignal.stopped = true; return r; }),                                                                                      
         ]);                                                                                                                                                                                       
         const stdout = tailResult.status === "fulfilled" ? tailResult.value : "";                                                                                                                 
                                                                                                                                                                                                   
     Keep waitForJobCompletion unchanged. Keep the existing `keepaliveTimer`                                                                                                                       
     and `cancelSignal` / cancel-polling machinery unchanged — those are                                                                                                                           
     independent of log streaming.                                                                                                                                                                 
                                                                                                                                                                                                   
  8. ADD log file cleanup. Find `cleanupJob` (the function that deletes the                                                                                                                        
     K8s Job). After successful deletion, best-effort delete the log file:                                                                                                                         
         try { await fs.promises.unlink(podLogPath); } catch { /* non-fatal */ }                                                                                                                   
     Skip the unlink if `retainJobs === true`.                                                                                                                                                     
     cleanupJob will need podLogPath passed in; thread it from the caller.                                                                                                                         
                                                                                                                                                                                                   
  --- Delete entire files ---                                                                                                                                                                      
                                                                                                                                                                                                   
    - src/server/log-dedup.ts                                                                                                                                                                      
    - src/server/log-dedup.test.ts                          
                                                                                                                                                                                                   
  --- Tests ---                                                                                                                                                                                    
                                                                                                                                                                                                   
    - Delete any execute.test.ts tests covering streamPodLogsOnce,                                                                                                                                 
      streamPodLogs, readPodLogs, waitForPodTermination, the bail timer, or
      LogLineDedupFilter. Search for those identifiers; remove matching                                                                                                                            
      describe/it blocks. Non-log-streaming tests in the same file stay.                                                                                                                           
    - Add test cases for tailPodLogFile to execute.test.ts. Cover:                                                                                                                                 
        1. File appears within 30s; content is tailed line-by-line                                                                                                                                 
        2. File never appears; function throws with expected message                                                                                                                               
        3. Partial trailing line buffered and emitted on next poll                                                                                                                                 
        4. Stop signal exits the loop; final drain reads remaining bytes                                                                                                                           
        5. Adaptive backoff: idle polls slow; active polls speed up                                                                                                                                
      Use vitest fake timers (vi.useFakeTimers) and a tmpdir via                                                                                                                                   
      `fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-tailer-'))`.                                                                                                                                
                                                                                                                                                                                                   
  =============================================================================                                                                                                                    
  TESTING                                                                                                                                                                                          
  =============================================================================                                                                                                                    
                                                                                                                                                                                                   
  After all changes:                                                                                                                                                                               
    1. `npm run typecheck` — must pass (the `as ServerAdapterModule` cast                                                                                                                          
       may be needed; mirror claude-k8s's pattern)                                                                                                                                                 
    2. `npm test` — must pass. Test count will drop vs baseline because you                                                                                                                        
       deleted tests. Record the new passing count.                                                                                                                                                
                                                                                                                                                                                                   
  Do NOT run the adapter end-to-end. Do NOT require a k8s cluster.                                                                                                                                 
                                                                                                                                                                                                   
  =============================================================================                                                                                                                    
  BRANCH, COMMIT, PUSH, PR                                  
  =============================================================================                                                                                                                    
                                                                                                                                                                                                   
  1. Create a new branch off master:                                                                                                                                                               
         git checkout master && git pull && git checkout -b feat/filesystem-log-tail-and-liveness-flag                                                                                             
                                                                                                                                                                                                   
  2. Make all changes above. Commit as ONE commit:                                                                                                                                                 
                                                                                                                                                                                                   
         feat: declare hasOutOfProcessLiveness and tail pod log from filesystem                                                                                                                    
                                                            
         Two coordinated fixes for long-running agent failures:                                                                                                                                    
                                                            
         (1) Declare hasOutOfProcessLiveness: true on the ServerAdapterModule.                                                                                                                     
             Without it the reaper treated this adapter as in-process, expected
             a local child PID, and marked every run process_lost after 5min                                                                                                                       
             staleness. Flag tells the reaper to use the staleness-based                                                                                                                           
             liveness window for out-of-process adapters.                                                                                                                                          
                                                                                                                                                                                                   
         (2) Replace k8s log API streaming with filesystem tailing. The k8s                                                                                                                        
             follow stream drops every ~3 seconds at production scale,                                                                                                                             
             exhausting the 50-attempt reconnect cap within 2.5 minutes. Pod                                                                                                                       
             now tees opencode's stdout to                                                                                                                                                         
             /paperclip/instances/default/run-logs/<companyId>/<agentId>/<runId>.pod.ndjson                                                                                                        
             on the shared PVC; adapter tails the file directly. kubectl logs -f                                                                                                                   
             still works (tee preserves stdout).                                                                                                                                                   
                                                                                                                                                                                                   
         Deletes:                                                                                                                                                                                  
         - LogLineDedupFilter and all reconnect logic                                                                                                                                              
         - streamPodLogsOnce, streamPodLogs, readPodLogs, waitForPodTermination                                                                                                                    
         - Both fallback paths (empty-stream and missing-sessionId)                                                                                                                                
                                                                                                                                                                                                   
         Adds:                                                                                                                                                                                     
         - tailPodLogFile: adaptive 250ms/1s poll loop with partial-line                                                                                                                           
           buffering and tail-drain on stopSignal                                                                                                                                                  
         - Log file cleanup tied to retainJobs                                                                                                                                                     
         - Path-component sanitization (companyId/agentId/runId must match                                                                                                                         
           [a-zA-Z0-9-]+)                                                                                                                                                                          
                                                                                                                                                                                                   
         Co-Authored-By: Claude Sonnet <noreply@anthropic.com>                                                                                                                                     
                                                                                                                                                                                                   
  3. Push:                                                                                                                                                                                         
         git push -u origin feat/filesystem-log-tail-and-liveness-flag
                                                                                                                                                                                                   
  4. Open a PR against master with `gh pr create`:                                                                                                                                                 
     Title: `feat: declare hasOutOfProcessLiveness and tail pod log from filesystem`                                                                                                               
     Body (use a heredoc):                                                                                                                                                                         
                                                                                                                                                                                                   
         ## Summary                                                                                                                                                                                
         - Declares `hasOutOfProcessLiveness: true` so the reaper uses                                                                                                                             
           staleness-based liveness instead of expecting a local PID                                                                                                                               
         - Pod tees opencode stdout to PVC; adapter tails the file directly                                                                                                                        
         - Eliminates k8s log API dependency for streaming                                                                                                                                         
         - Deletes LogLineDedupFilter, reconnect logic, both fallback paths                                                                                                                        
                                                                                                                                                                                                   
         ## Why                                                                                                                                                                                    
         At production scale (144 concurrent runs), two bugs combined:                                                                                                                             
         (a) no liveness flag → reaper marked runs process_lost at 5min                                                                                                                            
         (b) k8s log follow stream drops every ~3s, exhausting the 50-reconnect                                                                                                                    
         cap. Runs over ~2.5min lost live output; over 5min failed outright.                                                                                                                       
                                                                                                                                                                                                   
         Both must be fixed together — the flag alone doesn't help if the log                                                                                                                      
         stream still drops, and the log tail alone doesn't help if the reaper                                                                                                                     
         kills the run for missing PID.                                                                                                                                                            
                                                                                                                                                                                                   
         ## Path                                                                                                                                                                                   
         `/paperclip/instances/default/run-logs/<companyId>/<agentId>/<runId>.pod.ndjson`                                                                                                          
         — the `.pod.ndjson` suffix distinguishes the pod-written file from                                                                                                                        
         revitalize's server-side `<runId>.ndjson` log store.                                                                                                                                      
                                                                                                                                                                                                   
         ## Breaking                                                                                                                                                                               
         Old Job manifests (pre-tee) are incompatible — the tailer's 30s                                                                                                                           
         "file missing" window will surface an error on in-flight runs at                                                                                                                          
         deploy time. Operator retry required. Consistent with the companion                                                                                                                       
         change in paperclip-adapter-claude-k8s.                                                                                                                                                   
                                                                                                                                                                                                   
         ## Test plan                                                                                                                                                                              
         - [ ] npm test passes                                                                                                                                                                     
         - [ ] Manual: deploy to cluster, run a >5min agent, confirm live UI                                                                                                                       
               output and no reaper fire                                                                                                                                                           
         - [ ] Manual: verify kubectl logs -f still works on the Job pod                                                                                                                           
         - [ ] Manual: confirm log file is cleaned up when Job cleanup runs                                                                                                                        
               (retainJobs=false) and preserved when retainJobs=true                                                                                                                               
                                                                                                                                                                                                   
  =============================================================================                                                                                                                    
  WRAPPING UP                                                                                                                                                                                      
  =============================================================================                                                                                                                    
                                                                                                                                                                                                   
  Report back with:                                                                                                                                                                                
    1. Branch name and commit hash                                                                                                                                                                 
    2. PR URL                                                                                                                                                                                      
    3. Final test count (numbers will drop vs baseline because you deleted                                                                                                                         
       tests — record baseline and final)                                                                                                                                                          
    4. Line count of execute.ts before and after (should drop significantly)                                                                                                                       
    5. Any deviation from these instructions, with reason                                                                                                                                          
                                                                                                                                                                                                   
  If ANY of the following happens, STOP and report instead of improvising:                                                                                                                         
    - A file path doesn't match what's described (e.g. the mainCommand                                                                                                                             
      pattern has changed)                                                                                                                                                                         
    - A function you're supposed to delete has other callers you didn't                                                                                                                            
      expect (streamPodLogsOnce in particular may have test-only imports                                                                                                                           
      that need untangling)                                                                                                                                                                        
    - A test you're supposed to keep depends on something you deleted                                                                                                                              
    - Typecheck fails and the fix is non-obvious                                                                                                                                                   
    - The `as ServerAdapterModule` cast doesn't satisfy TypeScript                                                                                                                                 
                                                                                                                                                                                                   
  Do NOT push to master. Do NOT tag a version. Do NOT bump package.json                                                                                                                            
  version — leave it as-is.  
