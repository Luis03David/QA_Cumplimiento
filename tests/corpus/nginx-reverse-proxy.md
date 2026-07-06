# nginx as a reverse proxy

vendor: F5
product: NGINX
version: "1.25"
doc_type: vendor_doc
visibility: global

## Basic reverse proxy

Define an upstream group and proxy to it:

```
upstream app_backends {
    server 10.0.0.11:8080;
    server 10.0.0.12:8080;
}

server {
    listen 80;
    location / {
        proxy_pass http://app_backends;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Load balancing methods

By default nginx uses round-robin across the upstream servers. Add
`least_conn;` inside the upstream block to route to the server with the fewest
active connections, or `ip_hash;` for session affinity.

## Troubleshooting 502 Bad Gateway

A `502 Bad Gateway` means nginx could not get a valid response from an
upstream. Check that the backend is listening, look at
`/var/log/nginx/error.log`, and verify `proxy_pass` points at a reachable
address and port. Increase `proxy_read_timeout` if the backend is slow.
