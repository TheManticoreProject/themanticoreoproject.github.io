(function () {
  var els = document.querySelectorAll('[data-github-stars]');
  if (els.length === 0) return;

  var CACHE_KEY = 'manticore-stars';
  var CACHE_TTL = 60 * 60 * 1000;

  // e.g. https://github.com/TheManticoreProject/Delegations -> ["TheManticoreProject", "Delegations"]
  var owner = els[0].getAttribute('data-github-stars').split('/')[3];

  function apply(counts) {
    els.forEach(function (el) {
      var repo = el.getAttribute('data-github-stars').split('/')[4].toLowerCase();
      if (typeof counts[repo] === 'number') {
        el.textContent = counts[repo].toLocaleString();
      }
    });
  }

  try {
    var cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (cached && Date.now() - cached.time < CACHE_TTL) {
      apply(cached.counts);
      return;
    }
  } catch (e) {}

  fetch('https://api.github.com/orgs/' + owner + '/repos?per_page=100')
    .then(function (res) {
      if (!res.ok) throw new Error('GitHub API ' + res.status);
      return res.json();
    })
    .then(function (repos) {
      var counts = {};
      repos.forEach(function (repo) {
        counts[repo.name.toLowerCase()] = repo.stargazers_count;
      });
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ time: Date.now(), counts: counts }));
      } catch (e) {}
      apply(counts);
    })
    .catch(function () {});
})();
