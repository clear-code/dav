import prop from './prop';

export default function multiget(object) {
  return `<card:addressbook-multiget
              xmlns:c="urn:ietf:params:xml:ns:caldav"
              xmlns:card="urn:ietf:params:xml:ns:carddav"
              xmlns:cs="http://calendarserver.org/ns/"
              xmlns:ca="http://apple.com/ns/ical/"
              xmlns:d="DAV:">
    <d:prop>
      ${object.props.map(prop)}
    </d:prop>
    ${object.hrefs.map(href => '<d:href>' + href + '</d:href>').join('\n')}
  </card:addressbook-multiget>`;
}
