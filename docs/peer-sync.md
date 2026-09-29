# Adding from a federated server ("peer sync")

While the web app is pointed at a server you are federated with (the
server switcher in the top bar), its panels are the ones you know —
Artists, Albums, an album's songs, Genres, Recent Added, Search and the
File Explorer — with two additions on every row: what your own library
has of it, and one **Add** that copies it into your collection. A pressed
row becomes its job and shows the copy's progress in place.

The word in the UI is *Add* (to your collection). Nothing is kept in step
afterwards: a copy is a one-off job, and adding the same thing again only
copies what your library lacks by then.

## What you need

- **A federation pairing.** Both servers are paired with a federation
  ticket (see [federation-ticket.md](federation-ticket.md)). Browsing is
  read-only: a federation key carries no write permission on the other
  side.
- **The copy plug-in.** Admin › Discovery plug-ins › *Add to your
  collection* (`federation-copy`) must be on. When it is off the rows are
  exactly as before: no marks, no actions.
- **An account that may add.** The account must be allowed to start
  discovery jobs and to upload. The note in the side nav says which case
  you are in: "You can play, queue and add its music to your collection",
  or "Your account can't add to the library, so nothing here can be kept".
- **The other server's leave.** Each federation key has an *Allow copies*
  switch on the server that issued it (Admin › Federation › the key). With
  it off, a copy stops with "*Peer* does not allow copies with your
  server's key". The key's caps — stream rate, streams at once, and the
  daily transfer allowance — apply to copies as they do to playback; a
  copy that runs into the daily allowance stops there and keeps what
  landed.

## Where copies land

Every account has a **collection destination**: a library you may upload
to, a base folder inside it, and a layout of tag variables such as
`{{ARTIST}}/{{ALBUM}}` (the peer's name is available as `{{PEER}}`). The
bar above a federated server's list shows it — "Copies land in music ›
From peers › {{ARTIST}} › {{ALBUM}}" — with **Change…** to pick another
library, folder or layout. The same destination is used by the Discover
window's "Add to your collection" and by downloads.

Songs, albums and artists always file by tags. A **folder** asks, when you
press its Add:

- **Keep its layout** (the default): the folder lands under your base
  folder with the path it has inside the other server's library, its files
  named as they are there — `shared/Vosto/Underpass Remixes` becomes
  `music/From peers/Vosto/Underpass Remixes`.
- **Into a folder I choose**: the folder's files go into a folder of your
  choosing (its subfolders beneath it).
- **File by tags**, like everything else.

A copy never overwrites: a file already at the target path is skipped and
reported. A song you already have — by content hash, or failing that by
artist, title, album, track, disc and length — is skipped as *already
yours*, which is what makes adding an album, an artist or a folder twice
harmless.

## What the rows say

- **Artists**: "2 albums · 17 songs" and *Add artist*; "2 albums · you have
  1" and *Add the 1 you don't have*; or *all in your collection*. The
  numbers come from the other server's album list, loaded once per
  session; until it lands the row says "in your collection" when your
  library has the artist at all, and offers *Add what you're missing*.
- **Albums** (cards and search hits): a *yours* badge, or *Add album*. An
  album's page has a header with its facts and "you have N" counted song
  by song.
- **Songs** (an album's songs, a genre, Recent Added, search hits, the
  explorer's files): a tick, or *Add*. In the File Explorer a file row also
  shows the tags the other server's scanner read — "Sodium · Vosto ·
  3:41" — or "no tags", in which case a song copy lands by its file name.
- **Folders**: *Add folder* on a folder row; the bar counts the folder you
  are in ("this folder · 3 folders · 40 songs", or "8 songs · you have 3")
  and offers *Add this folder* — the gap, when the folder is all songs.
- **A pressed row** shows its job: queued (behind whom), copying with its
  count and a progress bar, in your collection with what was copied and
  what was skipped, stopped with the other server's reason and *Retry*,
  cancelled with what was kept and *Add the rest*. A folder that landed
  can be opened where it landed.

The **downloads strip** under Now Playing lists the running and failed
jobs and leads back to what each one copied; the **Downloads** panel
lists every file that landed, with the server it came from.

On a phone there is no hover: the Add is always there as an amber icon
(its words only for the partial case), the destination line shortens to
the path, the picker and the folder sheet open at the foot of the screen,
and a line under the list counts the live jobs while the strip is
off-screen.

## Settings

Admin › Discovery plug-ins › Jobs:

- **Jobs per account** (`discoveryJobs.maxQueuedPerUser`): how many jobs
  one account may have queued or running at once. Past it a new job is
  refused until some finish; the runner takes turns between accounts
  besides.
- **Largest folder to add** (`discoveryJobs.maxFolderSongs`, default
  1000): a folder with more songs than this is refused with the count, and
  the user adds its folders one at a time. One folder job holds the copy
  slot for as long as it runs.
- The concurrency setting bounds how many jobs run at once, as for every
  plug-in.

Admin › Federation › a key: **Allow copies**, and the key's caps.

## For the other server

A federated server sees reads only: the listings it already answers for
browsing (`/db/*`, `/file-explorer`, `/file-explorer/recursive`), the
metadata of a song, and the media fetches of the copy itself, which count
against the key's caps like playback. It never learns what the copying
server keeps, and it is never written to.

## API notes

- `POST /api/v1/discovery/owned` answers, for lists of songs, albums and
  artists, what the caller's libraries hold — by the same rules the copy
  plug-in skips by, so a mark on a row and a skip in a job can never
  disagree. The boot payload's `features.discoveryOwned` flag says a
  server has it.
- A folder copy is the `federation-copy` plug-in's `folder` scope; the
  job body's optional `landing` (`{ vpath, path }` or `{ tags: true }`)
  is the folder sheet's answer, mirror when absent. Album and artist
  copies are the `album`, `artist` and `artist-missing` scopes.
- Everything here is additive; the mobile app keeps working as before and
  can pick the rows up later.
