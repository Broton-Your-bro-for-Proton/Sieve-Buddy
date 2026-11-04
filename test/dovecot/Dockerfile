# Dovecot + Pigeonhole (ManageSieve) for end-to-end tests. NOT for production: plaintext auth allowed,
# self-signed certificate, fixed test user.
FROM debian:bookworm-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dovecot-imapd dovecot-managesieved dovecot-sieve openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=dovecot.test" -keyout /etc/dovecot/key.pem -out /etc/dovecot/cert.pem \
 && groupadd -g 5000 vmail && useradd -u 5000 -g vmail -d /srv/mail -s /usr/sbin/nologin vmail
COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY users /etc/dovecot/users
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 143 993 4190
ENTRYPOINT ["/entrypoint.sh"]
