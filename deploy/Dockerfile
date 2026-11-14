# The image of a server host: the release tarball unpacked on a small glibc base. It is the same
# tarball the install script installs, so it carries its own Node runtime. Build the tarball first
# with deploy/build.sh, then build this from the deploy directory (compose.yaml does both steps'
# second half: `docker compose build`).
FROM debian:bookworm-slim

# The release tarball, relative to the deploy directory.
ARG RELEASE=dist/uketsugi-0.1.0-linux-x64.tar.gz
ADD ${RELEASE} /opt/
# The data directory is its owner's alone, as `ukt setup` makes one and `ukt doctor`, the health
# check, requires; a new volume takes the mode it has here.
RUN mv /opt/uketsugi-*-linux-x64 /opt/uketsugi \
  && useradd --system --uid 10001 --home-dir /data --create-home uketsugi \
  && chmod 700 /data

ENV PATH=/opt/uketsugi/bin:$PATH \
  UKT_DATA_DIR=/data \
  UKT_HOST=0.0.0.0 \
  UKT_PORT=7410
USER uketsugi
VOLUME /data
EXPOSE 7410

# `ukt setup` changes nothing that is in place: on the first start it makes the token and fetches
# the embedding model into the volume, and later starts only verify it. If the model cannot be
# fetched the server still starts, and search matches words only until a later start succeeds.
CMD ["sh", "-c", "ukt setup; exec ukt serve"]
