import co from 'co';
import url from 'url';

import fuzzyUrlEquals from './fuzzy_url_equals';
import { AddressBook, VCard } from './model';
import * as ns from './namespace';
import * as request from './request';
import * as webdav from './webdav';

let debug = require('debug')('dav:contacts');

/**
 * @param {dav.Account} account to fetch address books for.
 */
export let listAddressBooks = co.wrap(function *(account, options) {
  debug(`Fetch address books from home url ${account.homeUrl}`);
  var req = request.propfind({
    props: [
      { name: 'displayname', namespace: ns.DAV },
      { name: 'getctag', namespace: ns.CALENDAR_SERVER },
      { name: 'resourcetype', namespace: ns.DAV },
      { name: 'sync-token', namespace: ns.DAV }
    ],
    depth: 1
  });

  let responses = yield options.xhr.send(req, account.homeUrl, {
    sandbox: options.sandbox
  });

  let addressBooks = responses
    .filter(res => {
      return typeof res.props.displayname === 'string';
    })
    .map(res => {
      debug(`Found address book named ${res.props.displayname},
             props: ${JSON.stringify(res.props)}`);
      return new AddressBook({
        data: res,
        account: account,
        url: url.resolve(account.rootUrl, res.href),
        ctag: res.props.getctag,
        displayName: res.props.displayname,
        resourcetype: res.props.resourcetype,
        syncToken: res.props.syncToken
      });
    });

  yield addressBooks.map(co.wrap(function *(addressBook) {
    addressBook.reports = yield webdav.supportedReportSet(addressBook, options);
  }));

  return addressBooks;
});

/**
 * @param {dav.AddressBook} addressBook the address book to put the object on.
 * @return {Promise} promise will resolve when the card has been created.
 *
 * Options:
 *
 *   (String) data - vcard object.
 *   (String) filename - name for the address book vcf file.
 *   (dav.Sandbox) sandbox - optional request sandbox.
 *   (dav.Transport) xhr - request sender.
 */
export function createCard(addressBook, options) {
  let objectUrl = url.resolve(addressBook.url, options.filename);
  return webdav.createObject(objectUrl, options.data, options);
}

/**
 * Options:
 *
 *   (dav.Sandbox) sandbox - optional request sandbox.
 */
export let listVCards = co.wrap(function *(addressBook, options) {
  debug(`Doing REPORT on address book ${addressBook.url} which belongs to
        ${addressBook.account.credentials.username}`);

  var req = request.addressBookQuery({
    depth: 1,
    props: [
      { name: 'getetag', namespace: ns.DAV },
      { name: 'address-data', namespace: ns.CARDDAV }
    ]
  });

  let responses = yield options.xhr.send(req, addressBook.url, {
    sandbox: options.sandbox
  });

  return responses.map(res => {
    debug(`Found vcard with url ${res.href}`);
    return new VCard({
      data: res,
      addressBook: addressBook,
      url: url.resolve(addressBook.account.rootUrl, res.href),
      etag: res.props.getetag,
      addressData: res.props.addressData
    });
  });
});

/**
 * @param {dav.VCard} card updated vcard object.
 * @return {Promise} promise will resolve when the card has been updated.
 *
 * Options:
 *
 *   (dav.Sandbox) sandbox - optional request sandbox.
 *   (dav.Transport) xhr - request sender.
 */
export function updateCard(card, options) {
  return webdav.updateObject(
    card.url,
    card.addressData,
    card.etag,
    options
  );
}

/**
 * @param {dav.VCard} card target vcard object.
 * @return {Promise} promise will resolve when the calendar has been deleted.
 *
 * Options:
 *
 *   (dav.Sandbox) sandbox - optional request sandbox.
 *   (dav.Transport) xhr - request sender.
 */
export function deleteCard(card, options) {
  return webdav.deleteObject(
    card.url,
    card.etag,
    options
  );
}

/**
 * @param {dav.Calendar} calendar the calendar to fetch updates to.
 * @return {Promise} promise will resolve with updated calendar object.
 *
 * Options:
 *
 *   (dav.Sandbox) sandbox - optional request sandbox.
 *   (String) syncMethod - either 'basic' or 'webdav'. If unspecified, will
 *       try to do webdav sync and failover to basic sync if rfc 6578 is not
 *       supported by the server.
 *   (dav.Transport) xhr - request sender.
 */
export function syncAddressBook(addressBook, options) {
  options.basicSync = basicSync;
  options.webdavSync = webdavSync;
  return webdav.syncCollection(addressBook, options);
}

/**
 * @param {dav.Account} account the account to fetch updates for.
 * @return {Promise} promise will resolve with updated account.
 *
 * Options:
 *
 *   (dav.Sandbox) sandbox - optional request sandbox.
 *   (dav.Transport) xhr - request sender.
 */
export let syncCarddavAccount = co.wrap(function *(account, options={}) {
  options.loadObjects = false;

  if (!account.addressBooks) {
    account.addressBooks = [];
  }

  let addressBooks = yield listAddressBooks(account, options);
  addressBooks
    .filter(function(addressBook) {
      // Filter the address books not previously seen.
      return account.addressBooks.every(
        prev => !fuzzyUrlEquals(prev.url, addressBook.url)
      );
    })
    .forEach(addressBook => account.addressBooks.push(addressBook));

  options.loadObjects = true;
  yield account.addressBooks.map(co.wrap(function *(addressBook, index) {
    try {
      yield syncAddressBook(addressBook, options);
    } catch (error) {
      debug(`Syncing ${addressBook.displayName} failed with ${error}`);
      account.addressBooks.splice(index, 1);
    }
  }));

  return account;
});

let basicSync = co.wrap(function *(addressBook, options) {
  let sync = webdav.isCollectionDirty(addressBook, options)
  if (!sync) {
    debug('Local ctag matched remote! No need to sync :).');
    return addressBook;
  }

  debug('ctag changed so we need to fetch stuffs.');
  addressBook.objects = yield listVCards(addressBook, options);
  return addressBook;
});

let webdavSync = co.wrap(function *(addressBook, options) {
  const localVCards = {};
  if (!addressBook.objects)
    addressBook.objects = [];
  addressBook.objects.forEach((vcard, index) => {
    localVCards[vcard.url] = { vcard, index };
  });

  if (typeof options.xhr == 'function') {
    const req = request.propfind({
      props: [
        { name: 'getetag', namespace: ns.DAV }
      ],
      syncLevel: 1,
      syncToken: addressBook.syncToken
    });
    const result = yield options.xhr().send(req, addressBook.url, {
      sandbox: options.sandbox
    });

    const urlsToFetch = [];

    const remote = {};
    result.forEach(response => {
      const completedURL = url.resolve(addressBook.account.rootUrl, response.href);
      remote[completedURL] = true;
      const local = localVCards[completedURL];
      if (!local || // created
          local.vcard.etag != response.props.getetag) { // or updated
        urlsToFetch.push(response.href);
      }
    });

    if (urlsToFetch.length > 0) {
      const req = request.multiget({
        props: [
          { name: 'getetag', namespace: ns.DAV },
          { name: 'address-data', namespace: ns.CARDDAV }
        ],
        hrefs: urlsToFetch
      });

      const result = yield options.xhr().send(req, addressBook.url, {
        sandbox: options.sandbox
      });

      console.log(result);

      result.forEach(response => {
        if (!response.props.addressData) // not a card
          return;

        const completedURL = url.resolve(addressBook.account.rootUrl, response.href);
        const local = localVCards[completedURL];
        if (local) { // changed (always treat the remote as new)
          local.vcard.etag = response.props.getetag;
          local.vcard.addressData = response.props.addressData;
        }
        else { // created
          addressBook.objects.push(new VCard({
            data: response,
            addressBook: addressBook,
            url: completedURL,
            etag: response.props.getetag,
            addressData: response.props.addressData
          }));
        }
      });
    }

    // deleted
    addressBook.objects = addressBook.objects.filter(vcard => {
      return vcard.url in remote;
    });
  }
  else {
    const req = request.propfind({
      props: [
        { name: 'getetag', namespace: ns.DAV },
        { name: 'address-data', namespace: ns.CARDDAV }
      ],
      syncLevel: 1,
      syncToken: addressBook.syncToken
    });

    const result = yield options.xhr.send(req, addressBook.url, {
      sandbox: options.sandbox
    });

    const remote = {};
    result.forEach(response => {
      if (!response.props.addressData) // not a card
        return;

      const completedURL = url.resolve(addressBook.account.rootUrl, response.href);
      remote[completedURL] = true;

      const local = localVCards[completedURL];
      if (local) { // changed (always treat the remote as new)
        local.vcard.etag = response.props.getetag;
        local.vcard.addressData = response.props.addressData;
      }
      else { // created
        addressBook.objects.push(new VCard({
          data: response,
          addressBook: addressBook,
          url: completedURL,
          etag: response.props.getetag,
          addressData: response.props.addressData
        }));
      }
    });

    // deleted
    addressBook.objects = addressBook.objects.filter(vcard => {
      return vcard.url in remote;
    });
  }

  return addressBook;
});
