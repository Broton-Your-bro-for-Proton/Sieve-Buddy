#!/bin/sh
set -e
home=/srv/mail/test@example.test
# folders for the IMAP folder list (maildir++ on disk, "/" as separator; "&APw-" = ü in modified UTF-7)
for f in Shop Newsletter Rechnungen 'Archiv.2026' 'Entw&APw-rfe'; do
  mkdir -p "$home/Maildir/.$f/cur" "$home/Maildir/.$f/new" "$home/Maildir/.$f/tmp"
done
mkdir -p "$home/Maildir/cur" "$home/Maildir/new" "$home/Maildir/tmp" "$home/sieve"
chown -R vmail:vmail /srv/mail
exec dovecot -F
