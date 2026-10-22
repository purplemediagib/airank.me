export const draftFixture=async identity=>[
 ...['Mitkä palvelut sopivat pienyritykselle?','Mitä vaihtoehtoja kannattaa vertailla?','Mitkä ratkaisut ovat helppoja käyttää?','Mitä rajoituksia palveluilla on?'].map((text,i)=>({text,kind:'neutral',topic:['Sopivuus','Vertailu','Käyttö','Rajoitukset'][i],tags:[]})),
 ...[`Miten ${identity.brandName} sopii pienyritykselle?`,`Mitä rajoituksia palvelulla ${identity.brandName} on?`].map(text=>({text,kind:'diagnostic',topic:'Brändin arviointi',tags:['arviointi']})),
];
