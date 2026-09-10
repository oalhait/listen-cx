# Apple Music endpoint inventory

Surveyed September 9, 2026 from the [official Apple Music API index](https://developer.apple.com/documentation/applemusicapi), its top-level topics and linked endpoint pages. This lists 138 endpoint documentation entries and 119 distinct method/path combinations; some entries share paths but use different query parameters. It is not a runtime test or an inventory of every nested schema.

See [feasibility analysis](2026-09-09-playlist-provider-feasibility.md) for implications.

| Method | Path | Official endpoint documentation |
| --- | --- | --- |
| DELETE | `/v1/me/ratings/albums/{id}` | [Delete a Personal Album Rating](https://developer.apple.com/documentation/applemusicapi/delete-a-personal-content-rating-863sx) |
| DELETE | `/v1/me/ratings/library-albums/{id}` | [Delete a Personal Library Album Rating](https://developer.apple.com/documentation/applemusicapi/delete-a-personal-content-rating-32o8r) |
| DELETE | `/v1/me/ratings/library-music-videos/{id}` | [Delete a Personal Library Music Video Rating](https://developer.apple.com/documentation/applemusicapi/delete-a-personal-content-rating-1vj60) |
| DELETE | `/v1/me/ratings/library-playlists/{id}` | [Delete a Personal Library Playlist Rating](https://developer.apple.com/documentation/applemusicapi/delete-a-personal-content-rating-7vxs6) |
| DELETE | `/v1/me/ratings/library-songs/{id}` | [Delete a Personal Library Song Rating](https://developer.apple.com/documentation/applemusicapi/delete-a-personal-content-rating-2k02e) |
| DELETE | `/v1/me/ratings/music-videos/{id}` | [Delete a Personal Music Video Rating](https://developer.apple.com/documentation/applemusicapi/delete-a-personal-content-rating-9xd3d) |
| DELETE | `/v1/me/ratings/playlists/{id}` | [Delete a Personal Playlist Rating](https://developer.apple.com/documentation/applemusicapi/delete-a-personal-content-rating-mv3a) |
| DELETE | `/v1/me/ratings/songs/{id}` | [Delete a Personal Song Rating](https://developer.apple.com/documentation/applemusicapi/delete-a-personal-content-rating-3a3a2) |
| DELETE | `/v1/me/ratings/stations/{id}` | [Delete a Personal Station Rating](https://developer.apple.com/documentation/applemusicapi/delete-a-personal-content-rating-7pbcr) |
| GET | `/v1/catalog/{storefront}` | [Get Multiple Catalog Resources Using Resource-Typed ID Parameters](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-resources-by-resource-typed-ids-parameters) |
| GET | `/v1/catalog/{storefront}/activities` | [Get Multiple Catalog Activities](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-activities) |
| GET | `/v1/catalog/{storefront}/activities/{id}` | [Get a Catalog Activity](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-activity) |
| GET | `/v1/catalog/{storefront}/activities/{id}/{relationship}` | [Get a Catalog Activity's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-1eqct) |
| GET | `/v1/catalog/{storefront}/albums` | [Get Equivalent Catalog Albums by ID](https://developer.apple.com/documentation/applemusicapi/get-equivalent-ids-for-the-albums-8aky3) |
| GET | `/v1/catalog/{storefront}/albums` | [Get Multiple Catalog Albums](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-albums) |
| GET | `/v1/catalog/{storefront}/albums` | [Get Multiple Catalog Albums by UPC](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-albums-by-upc) |
| GET | `/v1/catalog/{storefront}/albums/{id}` | [Get a Catalog Album](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-album) |
| GET | `/v1/catalog/{storefront}/albums/{id}/view/{view}` | [Get a Catalog Album’s Relationship View Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-2we6l) |
| GET | `/v1/catalog/{storefront}/albums/{id}/{relationship}` | [Get a Catalog Album's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-4hthr) |
| GET | `/v1/catalog/{storefront}/apple-curators` | [Get Multiple Catalog Apple Curators](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-apple-curators) |
| GET | `/v1/catalog/{storefront}/apple-curators/{id}` | [Get a Catalog Apple Curator](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-apple-curator) |
| GET | `/v1/catalog/{storefront}/apple-curators/{id}/{relationship}` | [Get a Catalog Apple Curator's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-9aupk) |
| GET | `/v1/catalog/{storefront}/artists` | [Get Multiple Catalog Artists](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-artists) |
| GET | `/v1/catalog/{storefront}/artists/{id}` | [Get a Catalog Artist](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-artist) |
| GET | `/v1/catalog/{storefront}/artists/{id}/view/{view}` | [Get a Catalog Artist’s Relationship View Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-4kow5) |
| GET | `/v1/catalog/{storefront}/artists/{id}/{relationship}` | [Get a Catalog Artist's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5akdm) |
| GET | `/v1/catalog/{storefront}/charts` | [Get Catalog Charts](https://developer.apple.com/documentation/applemusicapi/charts) |
| GET | `/v1/catalog/{storefront}/curators` | [Get Multiple Catalog Curators](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-curators) |
| GET | `/v1/catalog/{storefront}/curators/{id}` | [Get a Catalog Curator](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-curator) |
| GET | `/v1/catalog/{storefront}/curators/{id}/{relationship}` | [Get a Catalog Curator's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-1091z) |
| GET | `/v1/catalog/{storefront}/genres` | [Get Catalog Top Charts Genres](https://developer.apple.com/documentation/applemusicapi/get-all-genres) |
| GET | `/v1/catalog/{storefront}/genres` | [Get Multiple Catalog Genres](https://developer.apple.com/documentation/applemusicapi/get-multiple-genres) |
| GET | `/v1/catalog/{storefront}/genres/{id}` | [Get a Catalog Genre](https://developer.apple.com/documentation/applemusicapi/get-a-genre) |
| GET | `/v1/catalog/{storefront}/music-videos` | [Get Equivalent Catalog Music Videos by ID](https://developer.apple.com/documentation/applemusicapi/get-equivalent-ids-for-the-albums-8tp4l) |
| GET | `/v1/catalog/{storefront}/music-videos` | [Get Multiple Catalog Music Videos by ID](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-music-videos-by-id) |
| GET | `/v1/catalog/{storefront}/music-videos` | [Get Multiple Catalog Music Videos by ISRC](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-music-videos-by-isrc) |
| GET | `/v1/catalog/{storefront}/music-videos/{id}` | [Get a Catalog Music Video](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-music-video) |
| GET | `/v1/catalog/{storefront}/music-videos/{id}/view/{view}` | [Get a Catalog Music Video’s Relationship View Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-5657g) |
| GET | `/v1/catalog/{storefront}/music-videos/{id}/{relationship}` | [Get a Catalog Music Video's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-4z79l) |
| GET | `/v1/catalog/{storefront}/playlists` | [Get Charts Playlists by Storefront Value](https://developer.apple.com/documentation/applemusicapi/get-charts-playlists-by-storefront-value) |
| GET | `/v1/catalog/{storefront}/playlists` | [Get Multiple Catalog Playlists](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-playlists) |
| GET | `/v1/catalog/{storefront}/playlists/{id}` | [Get a Catalog Playlist](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-playlist) |
| GET | `/v1/catalog/{storefront}/playlists/{id}/view/{view}` | [Get a Catalog Playlist’s Relationship View Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-6i3ek) |
| GET | `/v1/catalog/{storefront}/playlists/{id}/{relationship}` | [Get a Catalog Playlist's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-707nb) |
| GET | `/v1/catalog/{storefront}/record-labels` | [Get Multiple Record Labels](https://developer.apple.com/documentation/applemusicapi/get-multiple-record-labels) |
| GET | `/v1/catalog/{storefront}/record-labels/{id}` | [Get a Catalog Record Label](https://developer.apple.com/documentation/applemusicapi/get-a-record-label) |
| GET | `/v1/catalog/{storefront}/record-labels/{id}/view/{view}` | [Get a Catalog Record Label’s Relationship View Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-5uhxd) |
| GET | `/v1/catalog/{storefront}/search` | [Search for Catalog Resources](https://developer.apple.com/documentation/applemusicapi/search-for-catalog-resources-(by-type)) |
| GET | `/v1/catalog/{storefront}/search/hints` | [Get Catalog Search Hints](https://developer.apple.com/documentation/applemusicapi/get-catalog-search-hints) |
| GET | `/v1/catalog/{storefront}/search/suggestions` | [Get Catalog Search Suggestions](https://developer.apple.com/documentation/applemusicapi/get-catalog-search-suggesions) |
| GET | `/v1/catalog/{storefront}/songs` | [Get Equivalent Catalog Songs by ID](https://developer.apple.com/documentation/applemusicapi/get-equivalent-ids-for-the-albums-3ce20) |
| GET | `/v1/catalog/{storefront}/songs` | [Get Multiple Catalog Songs by ID](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-id) |
| GET | `/v1/catalog/{storefront}/songs` | [Get Multiple Catalog Songs by ISRC](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc) |
| GET | `/v1/catalog/{storefront}/songs/{id}` | [Get a Catalog Song](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-song) |
| GET | `/v1/catalog/{storefront}/songs/{id}/{relationship}` | [Get a Catalog Song's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-56rq7) |
| GET | `/v1/catalog/{storefront}/station-genres` | [Get All Station Genres](https://developer.apple.com/documentation/applemusicapi/get-all-station-genres) |
| GET | `/v1/catalog/{storefront}/station-genres` | [Get Multiple Stations Genres](https://developer.apple.com/documentation/applemusicapi/get-multiple-stations-genres) |
| GET | `/v1/catalog/{storefront}/station-genres/{id}` | [Get a Station Genre](https://developer.apple.com/documentation/applemusicapi/get-a-station-genre) |
| GET | `/v1/catalog/{storefront}/station-genres/{id}/{relationship}` | [Get a Station Genre’s Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-i4r0) |
| GET | `/v1/catalog/{storefront}/stations` | [Get Multiple Catalog Stations](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-stations) |
| GET | `/v1/catalog/{storefront}/stations` | [Get the Apple Music Live Radio Stations](https://developer.apple.com/documentation/applemusicapi/get-the-apple-music-live-radio-stations) |
| GET | `/v1/catalog/{storefront}/stations` | [Get the User's Personal Apple Music Station](https://developer.apple.com/documentation/applemusicapi/get-the-user's-personal-apple-music-station) |
| GET | `/v1/catalog/{storefront}/stations/{id}` | [Get a Catalog Station](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-station) |
| GET | `/v1/catalog/{storefront}/stations/{id}/{relationship}` | [Get a Catalog Station's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-38wmf) |
| GET | `/v1/language/{storefront}/tag` | [Get the best supported language for a storefront](https://developer.apple.com/documentation/applemusicapi/get-the-best-supported-language-based-on-the-acceptlanguage) |
| GET | `/v1/me/history/heavy-rotation` | [Get Heavy Rotation Content](https://developer.apple.com/documentation/applemusicapi/get-heavy-rotation-content) |
| GET | `/v1/me/library` | [Get Multiple Library Resources Using Resource-Typed ID Parameters](https://developer.apple.com/documentation/applemusicapi/get-multiple-library-resources-by-resource-typed-ids-parameters) |
| GET | `/v1/me/library/albums` | [Get All Library Albums](https://developer.apple.com/documentation/applemusicapi/get-all-library-albums) |
| GET | `/v1/me/library/albums` | [Get Multiple Library Albums](https://developer.apple.com/documentation/applemusicapi/get-multiple-library-albums) |
| GET | `/v1/me/library/albums/{id}` | [Get a Library Album](https://developer.apple.com/documentation/applemusicapi/get-a-library-album) |
| GET | `/v1/me/library/albums/{id}/{relationship}` | [Get a Library Album's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-165fz) |
| GET | `/v1/me/library/artists` | [Get All Library Artists](https://developer.apple.com/documentation/applemusicapi/get-all-library-artists) |
| GET | `/v1/me/library/artists` | [Get Multiple Library Artists](https://developer.apple.com/documentation/applemusicapi/get-multiple-library-artists) |
| GET | `/v1/me/library/artists/{id}` | [Get a Library Artist](https://developer.apple.com/documentation/applemusicapi/get-a-library-artist) |
| GET | `/v1/me/library/artists/{id}/{relationship}` | [Get a Library Artist's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-9dsoc) |
| GET | `/v1/me/library/music-videos` | [Get All Library Music Videos](https://developer.apple.com/documentation/applemusicapi/get-all-library-music-videos) |
| GET | `/v1/me/library/music-videos` | [Get Multiple Library Music Videos](https://developer.apple.com/documentation/applemusicapi/get-multiple-library-music-videos) |
| GET | `/v1/me/library/music-videos/{id}` | [Get a Library Music Video](https://developer.apple.com/documentation/applemusicapi/get-a-library-music-video) |
| GET | `/v1/me/library/music-videos/{id}/{relationship}` | [Get a Library Music Video's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-419dz) |
| GET | `/v1/me/library/playlist-folders` | [Get Multiple Library Playlist Folders](https://developer.apple.com/documentation/applemusicapi/get-multiple-library-playlist-folders) |
| GET | `/v1/me/library/playlist-folders` | [Get Root Library Playlists Folder](https://developer.apple.com/documentation/applemusicapi/get-root-library-playlists-folder) |
| GET | `/v1/me/library/playlist-folders/{id}` | [Get a Library Playlist Folder](https://developer.apple.com/documentation/applemusicapi/get-a-library-playlist-folder) |
| GET | `/v1/me/library/playlist-folders/{id}/{relationship}` | [Get a Library Playlist Folder’s Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-r5gv) |
| GET | `/v1/me/library/playlists` | [Get All Library Playlists](https://developer.apple.com/documentation/applemusicapi/get-all-library-playlists) |
| GET | `/v1/me/library/playlists` | [Get Multiple Library Playlists](https://developer.apple.com/documentation/applemusicapi/get-multiple-library-playlists) |
| GET | `/v1/me/library/playlists/{id}` | [Get a Library Playlist](https://developer.apple.com/documentation/applemusicapi/get-a-library-playlist) |
| GET | `/v1/me/library/playlists/{id}/{relationship}` | [Get a Library Playlist's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5l22w) |
| GET | `/v1/me/library/recently-added` | [Get Recently Added Resources](https://developer.apple.com/documentation/applemusicapi/get-recently-added-resources) |
| GET | `/v1/me/library/search` | [Search for Library Resources](https://developer.apple.com/documentation/applemusicapi/search-for-library-resources) |
| GET | `/v1/me/library/songs` | [Get All Library Songs](https://developer.apple.com/documentation/applemusicapi/get-all-library-songs) |
| GET | `/v1/me/library/songs` | [Get Multiple Library Songs](https://developer.apple.com/documentation/applemusicapi/get-multiple-library-songs) |
| GET | `/v1/me/library/songs/{id}` | [Get a Library Song](https://developer.apple.com/documentation/applemusicapi/get-a-library-song) |
| GET | `/v1/me/library/songs/{id}/{relationship}` | [Get a Library Song's Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-9xvg6) |
| GET | `/v1/me/music-summaries` | [Get the user's replay data](https://developer.apple.com/documentation/applemusicapi/get-the-user's-replay-data) |
| GET | `/v1/me/ratings/albums` | [Get Multiple Personal Album Ratings](https://developer.apple.com/documentation/applemusicapi/get-multiple-personal-content-ratings-8tjvr) |
| GET | `/v1/me/ratings/albums/{id}` | [Get a Personal Album Rating](https://developer.apple.com/documentation/applemusicapi/get-a-personal-content-rating-1q2mb) |
| GET | `/v1/me/ratings/library-albums` | [Get Multiple Personal Library Album Ratings](https://developer.apple.com/documentation/applemusicapi/get-multiple-personal-content-ratings-5px7a) |
| GET | `/v1/me/ratings/library-albums/{id}` | [Get a Personal Library Album Rating](https://developer.apple.com/documentation/applemusicapi/get-a-personal-content-rating-6c3b8) |
| GET | `/v1/me/ratings/library-music-videos` | [Get Multiple Personal Library Music Video Ratings](https://developer.apple.com/documentation/applemusicapi/get-multiple-personal-content-ratings-63ybs) |
| GET | `/v1/me/ratings/library-music-videos/{id}` | [Get a Personal Library Music Video Rating](https://developer.apple.com/documentation/applemusicapi/get-a-personal-content-rating-4bir7) |
| GET | `/v1/me/ratings/library-playlists` | [Get Multiple Personal Library Playlist Ratings](https://developer.apple.com/documentation/applemusicapi/get-multiple-personal-content-ratings-25kr7) |
| GET | `/v1/me/ratings/library-playlists/{id}` | [Get a Personal Library Playlist Rating](https://developer.apple.com/documentation/applemusicapi/get-a-personal-content-rating-htyl) |
| GET | `/v1/me/ratings/library-songs` | [Get Multiple Personal Library Songs Ratings](https://developer.apple.com/documentation/applemusicapi/get-multiple-personal-content-ratings-1bod7) |
| GET | `/v1/me/ratings/library-songs/{id}` | [Get a Personal Library Song Rating](https://developer.apple.com/documentation/applemusicapi/get-a-personal-content-rating-7olcw) |
| GET | `/v1/me/ratings/music-videos` | [Get Multiple Personal Music Video Ratings](https://developer.apple.com/documentation/applemusicapi/get-multiple-personal-content-ratings-74o7x) |
| GET | `/v1/me/ratings/music-videos/{id}` | [Get a Personal Music Video Rating](https://developer.apple.com/documentation/applemusicapi/get-a-personal-content-rating-8doe0) |
| GET | `/v1/me/ratings/playlists` | [Get Multiple Personal Playlist Ratings](https://developer.apple.com/documentation/applemusicapi/get-multiple-personal-content-ratings-7i7bv) |
| GET | `/v1/me/ratings/playlists/{id}` | [Get a Personal Playlist Rating](https://developer.apple.com/documentation/applemusicapi/get-a-personal-content-rating-6wib7) |
| GET | `/v1/me/ratings/songs` | [Get Multiple Personal Song Ratings](https://developer.apple.com/documentation/applemusicapi/get-multiple-personal-content-ratings-6wab5) |
| GET | `/v1/me/ratings/songs/{id}` | [Get a Personal Song Rating](https://developer.apple.com/documentation/applemusicapi/get-a-personal-content-rating-4k9c0) |
| GET | `/v1/me/ratings/stations` | [Get Multiple Personal Station Ratings](https://developer.apple.com/documentation/applemusicapi/get-multiple-personal-content-ratings-7ycdc) |
| GET | `/v1/me/ratings/stations/{id}` | [Get a Personal Station Rating](https://developer.apple.com/documentation/applemusicapi/get-a-personal-content-rating-try2) |
| GET | `/v1/me/recent/played` | [Get Recently Played Resources](https://developer.apple.com/documentation/applemusicapi/get-recently-played-resources) |
| GET | `/v1/me/recent/played/tracks` | [Get Recently Played Tracks](https://developer.apple.com/documentation/applemusicapi/get-v1-me-recent-played-tracks) |
| GET | `/v1/me/recent/radio-stations` | [Get Recently Played Stations](https://developer.apple.com/documentation/applemusicapi/get-recently-played-stations) |
| GET | `/v1/me/recommendations` | [Get Default Recommendations](https://developer.apple.com/documentation/applemusicapi/get-all-recommendations) |
| GET | `/v1/me/recommendations` | [Get Multiple Recommendations](https://developer.apple.com/documentation/applemusicapi/get-multiple-recommendations) |
| GET | `/v1/me/recommendations/{id}` | [Get a Recommendation](https://developer.apple.com/documentation/applemusicapi/get-a-recommendation) |
| GET | `/v1/me/recommendations/{id}/{relationship}` | [Get a Recommendation Relationship Directly by Name](https://developer.apple.com/documentation/applemusicapi/get-a-relationship-on-the-recommendation) |
| GET | `/v1/me/storefront` | [Get a User's Storefront](https://developer.apple.com/documentation/applemusicapi/get-a-user's-storefront) |
| GET | `/v1/storefronts` | [Get All Storefronts](https://developer.apple.com/documentation/applemusicapi/get-all-storefronts) |
| GET | `/v1/storefronts` | [Get Multiple Storefronts](https://developer.apple.com/documentation/applemusicapi/get-multiple-storefronts) |
| GET | `/v1/storefronts/{id}` | [Get a Storefront](https://developer.apple.com/documentation/applemusicapi/get-a-storefront) |
| GET | `/v1/test` | [Placeholder Endpoint to Test Connectivity](https://developer.apple.com/documentation/applemusicapi/dummy-endpoint-to-test-connectivity) |
| POST | `/v1/me/favorites` | [Add resource to favorites](https://developer.apple.com/documentation/applemusicapi/add-resource-to-favorites) |
| POST | `/v1/me/library` | [Add a Resource to a Library](https://developer.apple.com/documentation/applemusicapi/add-a-resource-to-a-library) |
| POST | `/v1/me/library/playlist-folders` | [Create a New Library Playlist Folder](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist-folder) |
| POST | `/v1/me/library/playlists` | [Create a New Library Playlist](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist) |
| POST | `/v1/me/library/playlists/{id}/tracks` | [Add Tracks to a Library Playlist](https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist) |
| PUT | `/v1/me/ratings/albums/{id}` | [Add a Personal Album Rating](https://developer.apple.com/documentation/applemusicapi/add-a-personal-content-rating-4zesn) |
| PUT | `/v1/me/ratings/library-albums/{id}` | [Add a Personal Library Album Rating](https://developer.apple.com/documentation/applemusicapi/add-a-personal-content-rating-98xt0) |
| PUT | `/v1/me/ratings/library-music-videos/{id}` | [Add a Personal Library Music Video Rating](https://developer.apple.com/documentation/applemusicapi/add-a-personal-content-rating-58x8v) |
| PUT | `/v1/me/ratings/library-playlists/{id}` | [Add a Personal Library Playlist Rating](https://developer.apple.com/documentation/applemusicapi/add-a-personal-content-rating-91fzd) |
| PUT | `/v1/me/ratings/library-songs/{id}` | [Add a Personal Library Song Rating](https://developer.apple.com/documentation/applemusicapi/add-a-personal-content-rating-8z1fn) |
| PUT | `/v1/me/ratings/music-videos/{id}` | [Add a Personal Music Video Rating](https://developer.apple.com/documentation/applemusicapi/add-a-personal-content-rating-8hke5) |
| PUT | `/v1/me/ratings/playlists/{id}` | [Add a Personal Playlist Rating](https://developer.apple.com/documentation/applemusicapi/add-a-personal-content-rating-76n4r) |
| PUT | `/v1/me/ratings/songs/{id}` | [Add a Personal Song Rating](https://developer.apple.com/documentation/applemusicapi/add-a-personal-content-rating-33dop) |
| PUT | `/v1/me/ratings/stations/{id}` | [Add a Personal Station Rating](https://developer.apple.com/documentation/applemusicapi/add-a-personal-content-rating-8zlgo) |
