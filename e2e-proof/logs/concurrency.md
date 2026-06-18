# airlock e2e — concurrency, marking & queueing (live public URL)

**Public URL:** `https://travis-underground-orleans-closest.trycloudflare.com`  ·  cap=2 queue=3  ·  model delay=2s  ·  2026-06-18T18:53:07Z

## Worker reports its own cap (GET /)
```
{"name":"atlas","shape":"openai","endpoints":["POST /v1/chat/completions","POST /skills/{id}","GET /v1/runs/held"],"concurrency":{"max":2,"queue":3,"live":{"running":0,"waiting":0,"pending":0,"max_concurrency":2,"max_queue":3,"ewma_run_s":0.668,"est_wait_s":0.0}},"discovery":null,"contract":null}
```

## Fire 8 requests simultaneously; sample /metrics mid-flight

### /metrics during the burst (running = active, waiting = queued)
```
t+1: {"running":2,"waiting":3,"pending":5,"max_concurrency":2,"max_queue":3,"ewma_run_s":0.668,"est_wait_s":1.336}
t+2: {"running":2,"waiting":1,"pending":3,"max_concurrency":2,"max_queue":3,"ewma_run_s":1.372,"est_wait_s":1.372}
t+3: {"running":1,"waiting":0,"pending":1,"max_concurrency":2,"max_queue":3,"ewma_run_s":1.724,"est_wait_s":0.0}
t+4: {"running":1,"waiting":0,"pending":1,"max_concurrency":2,"max_queue":3,"ewma_run_s":1.724,"est_wait_s":0.0}
```

## Result — sorted by response time (the staircase = ran in batches of 2)
```
  req 7    HTTP 429     0.22s
  req 3    HTTP 429     0.26s
  req 6    HTTP 429     0.58s
  req 5    HTTP 200     2.21s
  req 2    HTTP 200     2.23s
  req 1    HTTP 200     4.28s
  req 4    HTTP 200     4.30s
  req 8    HTTP 200     6.32s
  --
  served(200)=5  shed(429)=3  wall=6.4s  (serial would be ~16s)
```

## Each admitted request kept its own marked run (distinct run_id)
```
5 concurrency runs recorded (the 3 shed 429s never started a run):
  conc-1    status=ok      steps=2 started=1781808791.77
  conc-2    status=ok      steps=2 started=1781808789.72
  conc-4    status=ok      steps=2 started=1781808791.78
  conc-5    status=ok      steps=2 started=1781808789.71
  conc-8    status=ok      steps=2 started=1781808793.82
```

_Marking holds under load: 5 admitted runs each got a distinct run_id; the 3 over-queue requests were shed with 429 before a run was created._
